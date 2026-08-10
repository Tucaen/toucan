import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildProjectContext } from "./project-context.mjs";

const ACTIVE_SESSION_STATUSES = new Set(["starting", "working", "waiting"]);

function newState(project) {
  return {
    version: 1,
    project,
    activeRunId: null,
    coordinatorStatus: "ready",
    messages: [],
    sessions: [],
    questions: [],
    events: []
  };
}

function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}

function validatePlan(plan) {
  if (!plan || typeof plan.message !== "string" || !Array.isArray(plan.delegations) || plan.delegations.length < 2) {
    throw new Error("Coordinator returned an invalid delegation plan.");
  }
  return plan;
}

function validateSessionResult(result) {
  if (!result || !Array.isArray(result.activities) || !result.activities.length || typeof result.summary !== "string") {
    throw new Error("Agent Session returned an invalid structured result.");
  }
  if (result.status === "needs_clarification" && !result.question?.trim()) {
    throw new Error("Agent Session requested clarification without a question.");
  }
  if (result.status === "completed" && !result.outcome?.trim()) {
    throw new Error("Agent Session completed without an outcome.");
  }
  if (!["needs_clarification", "completed"].includes(result.status)) {
    throw new Error(`Agent Session returned an unsupported status: ${result.status}`);
  }
  return result;
}

export class AdeRuntime {
  constructor({ projectPath, projectName, provider, eventStore, contextBuilder = buildProjectContext, now = () => new Date() }) {
    this.project = {
      id: "project-local",
      name: projectName ?? path.basename(projectPath),
      path: path.resolve(projectPath)
    };
    this.provider = provider;
    this.eventStore = eventStore;
    this.contextBuilder = contextBuilder;
    this.now = now;
    this.listeners = new Set();
    this.running = new Set();
    this.state = newState(this.project);
  }

  async initialize() {
    await this.eventStore.initialize();
    const restored = await this.eventStore.loadState();
    if (restored?.version === 1 && restored.project?.path === this.project.path) {
      this.state = restored;
    }
    return this.getState();
  }

  getState() {
    return structuredClone(this.state);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async record(type, summary, details = {}) {
    const event = {
      id: randomUUID(),
      runId: details.runId ?? this.state.activeRunId ?? "system",
      requestId: details.requestId ?? null,
      timestamp: this.now().toISOString(),
      actor: details.actor ?? "ade",
      type,
      summary,
      sessionId: details.sessionId ?? null,
      questionId: details.questionId ?? null,
      status: details.status ?? null,
      source: details.source ?? null
    };
    this.state.events.push(event);
    if (this.state.events.length > 250) this.state.events.splice(0, this.state.events.length - 250);
    await this.eventStore.append(event, this.state);
    for (const listener of this.listeners) listener(event, this.getState());
    return event;
  }

  hasActiveWork() {
    return this.state.coordinatorStatus === "working" || this.state.sessions.some((session) => ACTIVE_SESSION_STATUSES.has(session.status));
  }

  async startRequest(rawRequest) {
    const request = String(rawRequest ?? "").trim();
    if (!request) throw Object.assign(new Error("Coordinator request cannot be empty."), { statusCode: 400 });
    if (this.hasActiveWork()) {
      throw Object.assign(new Error("This thin slice runs one Coordinator request at a time."), { statusCode: 409 });
    }

    const runId = `run-${randomUUID()}`;
    const requestId = `request-${randomUUID()}`;
    this.state.activeRunId = runId;
    this.state.coordinatorStatus = "working";
    this.state.messages.push({ id: randomUUID(), role: "user", text: request, requestId, timestamp: this.now().toISOString() });
    await this.record("request.received", "Coordinator received the owner request.", { runId, requestId, actor: "owner", status: "active" });
    await this.record("coordinator.started", "Coordinator is reading the bounded Project context.", { runId, requestId, actor: "coordinator", status: "working" });

    let context;
    let plan;
    try {
      context = await this.contextBuilder(this.project.path);
      plan = validatePlan(await this.provider.coordinate({ request, project: this.project, context }));
    } catch (error) {
      this.state.coordinatorStatus = "failed";
      const message = `Coordinator failed: ${publicError(error)}`;
      this.state.messages.push({ id: randomUUID(), role: "assistant", text: message, requestId, timestamp: this.now().toISOString(), tone: "error" });
      await this.record("coordinator.failed", message, { runId, requestId, actor: "coordinator", status: "failed" });
      throw Object.assign(new Error(message), { statusCode: 502 });
    }

    this.state.coordinatorStatus = "ready";
    this.state.messages.push({
      id: randomUUID(),
      role: "assistant",
      text: plan.message,
      requestId,
      timestamp: this.now().toISOString(),
      provider: plan.model
    });
    await this.record("coordinator.responded", plan.message, { runId, requestId, actor: "coordinator", status: "ready" });

    const sessions = plan.delegations.map((delegation, index) => ({
      id: `session-${randomUUID()}`,
      runId,
      requestId,
      title: delegation.title,
      objective: delegation.objective,
      acceptanceCriteria: delegation.acceptanceCriteria,
      provider: plan.model,
      providerThreadId: null,
      status: "starting",
      phase: "explore",
      summary: "Coordinator created the delegation brief.",
      activity: "Waiting for the provider turn to start.",
      outcome: null,
      questionId: null,
      x: 54 + (index % 2) * 330,
      y: 58 + Math.floor(index / 2) * 230,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString()
    }));
    this.state.sessions.unshift(...sessions);
    for (const session of sessions) {
      await this.record("session.created", `Delegated “${session.title}”.`, {
        runId, requestId, sessionId: session.id, actor: "coordinator", status: "starting"
      });
    }

    const group = Promise.allSettled(sessions.map((session) => this.executeSession(session, context)));
    this.running.add(group);
    void group.finally(() => this.running.delete(group));
    return { runId, requestId, sessionIds: sessions.map((session) => session.id) };
  }

  async executeSession(session, context, answer = null, previousQuestion = null) {
    session.status = "working";
    session.phase = "build";
    session.activity = answer ? "Owner answer received; continuing the same provider-backed session." : "Model is analyzing the bounded Project context.";
    session.updatedAt = this.now().toISOString();
    await this.record(answer ? "session.resumed" : "session.started", session.activity, {
      runId: session.runId,
      requestId: session.requestId,
      sessionId: session.id,
      actor: "session",
      status: "working"
    });

    let result;
    try {
      result = validateSessionResult(await this.provider.runSession({
        session,
        project: this.project,
        context,
        answer,
        previousQuestion,
        onActivity: async (activity) => {
          session.activity = activity;
          session.updatedAt = this.now().toISOString();
          await this.record("session.activity", activity, {
            runId: session.runId,
            requestId: session.requestId,
            sessionId: session.id,
            actor: "session",
            status: "working"
          });
        }
      }));
    } catch (error) {
      session.status = "failed";
      session.phase = "review";
      session.summary = "The provider turn failed.";
      session.activity = publicError(error);
      session.updatedAt = this.now().toISOString();
      await this.record("session.failed", `${session.title}: ${session.activity}`, {
        runId: session.runId,
        requestId: session.requestId,
        sessionId: session.id,
        actor: "session",
        status: "failed"
      });
      return;
    }

    session.provider = result.model ?? session.provider;
    session.providerThreadId = result.providerThreadId ?? session.providerThreadId;
    session.summary = result.summary;
    session.activity = result.activities.at(-1) ?? result.summary;
    session.updatedAt = this.now().toISOString();
    for (const activity of result.activities) {
      await this.record("session.activity", activity, {
        runId: session.runId,
        requestId: session.requestId,
        sessionId: session.id,
        actor: "session",
        status: "working"
      });
    }

    if (result.status === "needs_clarification") {
      const question = {
        id: `question-${randomUUID()}`,
        runId: session.runId,
        requestId: session.requestId,
        sessionId: session.id,
        text: result.question,
        status: "open",
        answer: null,
        answeredFrom: null,
        askedAt: this.now().toISOString(),
        answeredAt: null
      };
      this.state.questions.push(question);
      session.questionId = question.id;
      session.status = "waiting";
      session.phase = "waiting";
      session.activity = "Waiting for the owner’s clarification.";
      await this.record("question.asked", result.question, {
        runId: session.runId,
        requestId: session.requestId,
        sessionId: session.id,
        questionId: question.id,
        actor: "session",
        status: "waiting"
      });
      return;
    }

    session.status = "completed";
    session.phase = "review";
    session.outcome = result.outcome;
    session.questionId = null;
    session.activity = result.outcome;
    await this.record("session.completed", `${session.title}: ${result.outcome}`, {
      runId: session.runId,
      requestId: session.requestId,
      sessionId: session.id,
      actor: "session",
      status: "completed"
    });
  }

  async answerQuestion(questionId, rawAnswer, source) {
    const answer = String(rawAnswer ?? "").trim();
    if (!answer) throw Object.assign(new Error("Clarification answer cannot be empty."), { statusCode: 400 });
    const question = this.state.questions.find((candidate) => candidate.id === questionId);
    if (!question) throw Object.assign(new Error("Clarification question was not found."), { statusCode: 404 });
    if (question.status !== "open") {
      throw Object.assign(new Error("This clarification was already answered."), { statusCode: 409 });
    }
    const session = this.state.sessions.find((candidate) => candidate.id === question.sessionId);
    if (!session) throw Object.assign(new Error("Originating Agent Session was not found."), { statusCode: 409 });

    question.status = "answered";
    question.answer = answer;
    question.answeredFrom = source === "session" ? "session card" : "Coordinator";
    question.answeredAt = this.now().toISOString();
    session.questionId = null;
    this.state.messages.push({
      id: randomUUID(),
      role: "user",
      text: `Answer to ${session.title}: ${answer}`,
      requestId: question.requestId,
      timestamp: this.now().toISOString(),
      source: question.answeredFrom
    });
    await this.record("question.answered", `Answered from the ${question.answeredFrom}: ${answer}`, {
      runId: question.runId,
      requestId: question.requestId,
      sessionId: session.id,
      questionId: question.id,
      actor: "owner",
      source: question.answeredFrom,
      status: "answered"
    });

    const context = await this.contextBuilder(this.project.path);
    const execution = this.executeSession(session, context, answer, question.text);
    this.running.add(execution);
    void execution.finally(() => this.running.delete(execution));
    return { questionId: question.id, sessionId: session.id };
  }

  async waitForIdle() {
    while (this.running.size) await Promise.allSettled([...this.running]);
    await this.eventStore.flush();
  }
}

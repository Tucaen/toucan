import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildProjectContext } from "./project-context.mjs";

const STATE_VERSION = 2;
const MAXIMUM_ACTIVITY = 8;
const MAXIMUM_TRANSCRIPT = 80;
const MAXIMUM_EVENTS = 400;
const SUMMARY_LIMIT = 160;
const IN_FLIGHT_STATUSES = new Set(["starting", "working"]);
const ANSWER_SOURCES = new Map([["coordinator", "Coordinator"], ["task card", "task card"]]);

/** The owner must ask for parallel work; a Coordinator Turn alone cannot fan out. */
const PARALLEL_REQUEST = /\b(parallel|concurrent(ly)?|simultaneous(ly)?|at the same time|(two|three|several|multiple)\s+(tasks|cards|agents|sessions))\b/i;

function newState(project) {
  return {
    version: STATE_VERSION,
    project,
    activeRunId: null,
    coordinatorStatus: "ready",
    messages: [],
    tasks: [],
    questions: [],
    events: []
  };
}

function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function concise(text, limit = SUMMARY_LIMIT) {
  const single = String(text ?? "").replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

function validatePlan(plan) {
  if (!plan || typeof plan.message !== "string" || !plan.message.trim()) {
    throw new Error("The Coordinator Turn returned no owner-visible message.");
  }
  if (!["answer", "delegate"].includes(plan.mode)) {
    throw new Error(`The Coordinator Turn returned an unsupported mode: ${plan.mode}`);
  }
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (plan.mode === "answer" && tasks.length) {
    throw new Error("A direct answer must not create task cards.");
  }
  if (plan.mode === "delegate" && !tasks.length) {
    throw new Error("A delegated request must brief at least one task.");
  }
  for (const task of tasks) {
    if (!task?.title?.trim() || !task?.objective?.trim() || !Array.isArray(task.acceptanceCriteria)) {
      throw new Error("The Coordinator Turn returned an incomplete task brief.");
    }
  }
  return {
    mode: plan.mode,
    message: plan.message,
    tasks,
    model: plan.model ?? null,
    coordinatorThreadId: plan.coordinatorThreadId ?? null
  };
}

function validateTaskResult(result) {
  if (!result || !Array.isArray(result.activities) || !result.activities.length || typeof result.summary !== "string") {
    throw new Error("The task returned an invalid structured result.");
  }
  if (!["needs_clarification", "completed"].includes(result.status)) {
    throw new Error(`The task returned an unsupported status: ${result.status}`);
  }
  if (result.status === "needs_clarification" && !result.question?.trim()) {
    throw new Error("The task requested clarification without a question.");
  }
  if (result.status === "completed" && !result.detail?.trim()) {
    throw new Error("The task completed without a detailed result.");
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
    this.busyTasks = new Set();
    this.state = newState(this.project);
  }

  async initialize() {
    await this.eventStore.initialize();
    const restored = await this.eventStore.loadState();
    if (restored?.version !== STATE_VERSION || restored.project?.path !== this.project.path) {
      return this.getState();
    }
    this.state = restored;
    for (const task of this.state.tasks.filter((candidate) => IN_FLIGHT_STATUSES.has(candidate.status))) {
      task.status = "unknown";
      task.summary = "ADE restarted while this task was running; its outcome is unknown and no turn was resumed.";
      task.updatedAt = this.now().toISOString();
      await this.record("task.outcome.unknown", `${task.title}: ${task.summary}`, {
        ...this.taskEvent(task), actor: "ade", status: "unknown"
      });
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

  /** Task and thread identity travel with every event so a run stays inspectable after the fact. */
  async record(type, summary, details = {}) {
    const event = {
      id: randomUUID(),
      runId: details.runId ?? this.state.activeRunId ?? "system",
      requestId: details.requestId ?? null,
      timestamp: this.now().toISOString(),
      actor: details.actor ?? "ade",
      type,
      summary,
      taskId: details.taskId ?? null,
      threadId: details.threadId ?? null,
      questionId: details.questionId ?? null,
      status: details.status ?? null,
      mode: details.mode ?? null,
      kind: details.kind ?? null,
      source: details.source ?? null
    };
    this.state.events.push(event);
    if (this.state.events.length > MAXIMUM_EVENTS) {
      this.state.events.splice(0, this.state.events.length - MAXIMUM_EVENTS);
    }
    await this.eventStore.append(event, this.state);
    for (const listener of this.listeners) listener(event, this.getState());
    return event;
  }

  /** The identity every event about one task carries. */
  taskEvent(task) {
    return { runId: task.runId, requestId: task.requestId, taskId: task.id, threadId: task.threadId };
  }

  taskOrThrow(taskId) {
    const task = this.state.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw httpError("That task card was not found.", 404);
    return task;
  }

  inspectTask(taskId) {
    const task = this.taskOrThrow(taskId);
    return {
      task: structuredClone(task),
      events: this.state.events.filter((event) => event.taskId === taskId).map((event) => structuredClone(event))
    };
  }

  addMessage(message) {
    const record = { id: randomUUID(), timestamp: this.now().toISOString(), ...message };
    this.state.messages.push(record);
    return record;
  }

  addTranscriptEntry(task, entry) {
    task.transcript.push({ id: randomUUID(), timestamp: this.now().toISOString(), ...entry });
    if (task.transcript.length > MAXIMUM_TRANSCRIPT) {
      task.transcript.splice(0, task.transcript.length - MAXIMUM_TRANSCRIPT);
    }
    task.updatedAt = this.now().toISOString();
  }

  /**
   * One activity entry on the owning card. `reported` steps come from the task's own result;
   * `internal` and `subagent` steps are provider mechanics and are counted, not headlined.
   */
  async noteActivity(task, { kind, text }) {
    task.activity.push({ id: randomUUID(), timestamp: this.now().toISOString(), kind, text });
    if (task.activity.length > MAXIMUM_ACTIVITY) {
      task.activity.splice(0, task.activity.length - MAXIMUM_ACTIVITY);
    }
    if (kind !== "reported") task.internalSteps += 1;
    task.updatedAt = this.now().toISOString();
    await this.record("task.activity", text, { ...this.taskEvent(task), actor: "task", kind, status: "working" });
  }

  /** One owner request: classified, then either answered here or delegated to task cards. */
  async submitRequest(rawRequest) {
    const request = String(rawRequest ?? "").trim();
    if (!request) throw httpError("A Coordinator request cannot be empty.", 400);
    if (this.state.coordinatorStatus === "working") {
      throw httpError("The Coordinator is already handling a request; its turns are deliberately short.", 409);
    }

    const runId = `run-${randomUUID()}`;
    const requestId = `request-${randomUUID()}`;
    this.state.activeRunId = runId;
    this.state.coordinatorStatus = "working";
    this.addMessage({ role: "owner", kind: "request", text: request, requestId });
    await this.record("request.received", "The Coordinator received an owner request.", { runId, requestId, actor: "owner", status: "active" });

    let context;
    let plan;
    try {
      context = await this.contextBuilder(this.project.path);
      plan = validatePlan(await this.provider.coordinate({
        request,
        project: this.project,
        context,
        tasks: this.state.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, summary: task.summary }))
      }));
    } catch (error) {
      this.state.coordinatorStatus = "failed";
      const message = `The Coordinator Turn failed: ${publicError(error)}`;
      this.addMessage({ role: "coordinator", kind: "error", text: message, requestId, tone: "error" });
      await this.record("coordinator.failed", message, { runId, requestId, actor: "coordinator", status: "failed" });
      throw httpError(message, 502);
    }

    this.state.coordinatorStatus = "ready";
    const coordinatorEvent = { runId, requestId, actor: "coordinator", threadId: plan.coordinatorThreadId, mode: plan.mode, status: "ready" };
    await this.record("request.classified", `Classified as ${plan.mode}.`, coordinatorEvent);

    const briefs = this.allowedBriefs(request, plan);
    const message = briefs.length < plan.tasks.length
      ? `${plan.message} I kept this to one task card; ask explicitly for parallel tasks if you want more.`
      : plan.message;
    if (briefs.length < plan.tasks.length) {
      await this.record("plan.clamped", `Kept one task card instead of ${plan.tasks.length}; the owner did not ask for parallel work.`, coordinatorEvent);
    }

    this.addMessage({
      role: "coordinator",
      kind: plan.mode === "answer" ? "answer" : "dispatch",
      text: message,
      requestId,
      provider: plan.model
    });
    await this.record(plan.mode === "answer" ? "coordinator.answered" : "coordinator.dispatched", message, coordinatorEvent);

    if (plan.mode === "answer") {
      return { runId, requestId, mode: plan.mode, taskIds: [] };
    }

    const tasks = briefs.map((brief) => this.createTask(brief, { runId, requestId, provider: plan.model }));
    for (const task of tasks) {
      await this.record("task.created", `Created the task card “${task.title}”.`, {
        ...this.taskEvent(task), actor: "coordinator", status: task.status
      });
    }
    for (const task of tasks) this.track(this.runTaskTurn(task, { context }));
    return { runId, requestId, mode: plan.mode, taskIds: tasks.map((task) => task.id) };
  }

  /** Fan-out needs the owner's own words, not the Coordinator Turn's preference. */
  allowedBriefs(request, plan) {
    return plan.tasks.length > 1 && !PARALLEL_REQUEST.test(request) ? plan.tasks.slice(0, 1) : plan.tasks;
  }

  createTask(brief, { runId, requestId, provider }) {
    const task = {
      id: `task-${randomUUID()}`,
      runId,
      requestId,
      title: brief.title,
      objective: brief.objective,
      acceptanceCriteria: brief.acceptanceCriteria,
      provider: provider ?? "Codex subscription",
      threadId: null,
      status: "starting",
      summary: "The Coordinator briefed this task; its thread is starting.",
      activity: [],
      transcript: [],
      internalSteps: 0,
      turns: 0,
      questionId: null,
      slot: this.state.tasks.length,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString()
    };
    this.state.tasks.unshift(task);
    return task;
  }

  /** Background turns own their own failure reporting; nothing here may escape as a bare rejection. */
  track(promise) {
    const guarded = promise.catch((error) => {
      console.error(`ADE task turn crashed: ${publicError(error)}`);
    });
    this.running.add(guarded);
    void guarded.finally(() => this.running.delete(guarded));
    return guarded;
  }

  /** Runs one turn of a task's own Codex thread and folds its result back into the card. */
  async runTaskTurn(task, { context, message = null, previousQuestion = null } = {}) {
    this.busyTasks.add(task.id);
    try {
      const projectContext = context ?? await this.contextBuilder(this.project.path);
      task.status = "working";
      task.turns += 1;
      task.summary = message ? "Continuing on the owner's follow-up." : "Reading the bounded Project context.";
      task.updatedAt = this.now().toISOString();
      await this.record(message ? "task.resumed" : "task.started", `${task.title}: ${task.summary}`, {
        ...this.taskEvent(task), actor: "task", status: "working"
      });

      const result = validateTaskResult(await this.provider.runTask({
        task,
        project: this.project,
        context: projectContext,
        message,
        previousQuestion,
        onThread: async (threadId) => this.attachThread(task, threadId),
        onActivity: async (activity) => this.noteActivity(task, { kind: activity.kind ?? "internal", text: activity.text })
      }));

      await this.attachThread(task, result.threadId);
      task.provider = result.model ?? task.provider;
      for (const activity of result.activities) {
        await this.noteActivity(task, { kind: "reported", text: activity });
      }

      if (result.status === "needs_clarification") await this.askQuestion(task, result);
      else await this.completeTask(task, result);
    } catch (error) {
      await this.failTask(task, publicError(error));
    } finally {
      this.busyTasks.delete(task.id);
    }
  }

  async attachThread(task, threadId) {
    if (!threadId || task.threadId === threadId) return;
    task.threadId = threadId;
    task.updatedAt = this.now().toISOString();
    await this.record("task.thread.attached", `“${task.title}” owns Codex thread ${threadId}.`, {
      ...this.taskEvent(task), actor: "ade", status: task.status
    });
  }

  async failTask(task, reason) {
    task.status = "failed";
    task.summary = concise(reason);
    task.updatedAt = this.now().toISOString();
    this.addTranscriptEntry(task, { role: "ade", text: reason });
    await this.record("task.failed", `${task.title}: ${reason}`, { ...this.taskEvent(task), actor: "task", status: "failed" });
    this.addMessage({
      role: "coordinator",
      kind: "task-summary",
      text: `${task.title} failed: ${task.summary} It ran in the read-only sandbox, so the Project was not modified; the card holds the full error and the task needs your decision.`,
      taskId: task.id,
      requestId: task.requestId,
      tone: "error"
    });
    await this.record("coordinator.summarized", `Reported the failure of “${task.title}”.`, {
      ...this.taskEvent(task), actor: "coordinator", status: "failed"
    });
  }

  async askQuestion(task, result) {
    const question = {
      id: `question-${randomUUID()}`,
      runId: task.runId,
      requestId: task.requestId,
      taskId: task.id,
      text: result.question,
      status: "open",
      answer: null,
      answeredFrom: null,
      askedAt: this.now().toISOString(),
      answeredAt: null
    };
    this.state.questions.push(question);
    task.questionId = question.id;
    task.status = "waiting";
    task.summary = concise(result.summary);
    task.updatedAt = this.now().toISOString();
    this.addTranscriptEntry(task, { role: "task", text: result.question, kind: "question" });
    await this.record("question.asked", result.question, {
      ...this.taskEvent(task), questionId: question.id, actor: "task", status: "waiting"
    });
  }

  /**
   * Completion keeps the detailed result in the card transcript and posts a concise Coordinator
   * line composed from the structured result, so no extra model turn is spent on narration.
   * The claim is the task's own report; this slice does not verify acceptance criteria.
   */
  async completeTask(task, result) {
    task.status = "completed";
    task.summary = concise(result.summary);
    task.questionId = null;
    task.updatedAt = this.now().toISOString();
    this.addTranscriptEntry(task, { role: "task", text: result.detail });
    await this.record("task.completed", `${task.title}: ${task.summary}`, {
      ...this.taskEvent(task), actor: "task", status: "completed"
    });
    this.addMessage({
      role: "coordinator",
      kind: "task-summary",
      text: `${task.title}: ${task.summary}`,
      taskId: task.id,
      requestId: task.requestId
    });
    await this.record("coordinator.summarized", `Summarized “${task.title}” as the task reported it.`, {
      ...this.taskEvent(task), actor: "coordinator", status: "completed"
    });
  }

  /** A follow-up on one task card: same task, same thread, and an answer when a question is open. */
  async sendTaskMessage(taskId, rawMessage, source = "task card") {
    const message = String(rawMessage ?? "").trim();
    if (!message) throw httpError("A task message cannot be empty.", 400);
    const answeredFrom = ANSWER_SOURCES.get(String(source ?? "task card"));
    if (!answeredFrom) throw httpError("A task message must come from the Coordinator or a task card.", 400);
    const task = this.taskOrThrow(taskId);
    if (this.busyTasks.has(task.id)) {
      throw httpError("That task is running; it accepts the next message at its next safe boundary.", 409);
    }

    const question = task.questionId
      ? this.state.questions.find((candidate) => candidate.id === task.questionId && candidate.status === "open")
      : null;
    this.addTranscriptEntry(task, { role: "owner", text: message, source: answeredFrom });

    if (question) {
      question.status = "answered";
      question.answer = message;
      question.answeredFrom = answeredFrom;
      question.answeredAt = this.now().toISOString();
      task.questionId = null;
      this.addMessage({
        role: "owner",
        kind: "decision",
        text: `Answer for ${task.title}: ${message}`,
        taskId: task.id,
        requestId: task.requestId,
        source: answeredFrom
      });
      await this.record("question.answered", `Answered from the ${answeredFrom}: ${message}`, {
        ...this.taskEvent(task), questionId: question.id, actor: "owner", source: answeredFrom, status: "answered"
      });
    } else {
      if (!IN_FLIGHT_STATUSES.has(task.status) && task.status !== "waiting") {
        await this.record("task.reopened", `The owner continued “${task.title}” after it stopped as ${task.status}.`, {
          ...this.taskEvent(task), actor: "owner", source: answeredFrom, status: task.status
        });
      }
      await this.record("task.message.sent", `Follow-up from the ${answeredFrom}: ${message}`, {
        ...this.taskEvent(task), actor: "owner", source: answeredFrom, status: "working"
      });
    }

    this.track(this.runTaskTurn(task, { message, previousQuestion: question?.text ?? null }));
    return { taskId: task.id, questionId: question?.id ?? null };
  }

  /** The Coordinator panel and the originating card answer the same durable question. */
  async answerQuestion(questionId, rawAnswer, source) {
    const question = this.state.questions.find((candidate) => candidate.id === questionId);
    if (!question) throw httpError("That clarification question was not found.", 404);
    if (question.status !== "open") throw httpError("That clarification was already answered.", 409);
    return this.sendTaskMessage(question.taskId, rawAnswer, source);
  }

  async waitForIdle() {
    while (this.running.size) await Promise.allSettled([...this.running]);
    await this.eventStore.flush();
  }
}

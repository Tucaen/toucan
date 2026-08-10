import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventStore } from "../src/event-store.mjs";
import { LONG_DETAIL, createRuntime, runOneTask } from "./helpers.mjs";

test("a direct question is answered in the Coordinator conversation without creating a task card", async () => {
  const { runtime, provider, eventStore } = createRuntime({
    plan: () => ({ mode: "answer", message: "This repository is a thin ADE slice.", tasks: [] })
  });
  await runtime.initialize();

  const accepted = await runtime.submitRequest("What is this repository?");
  await runtime.waitForIdle();

  const state = runtime.getState();
  assert.equal(accepted.mode, "answer");
  assert.deepEqual(accepted.taskIds, []);
  assert.equal(state.tasks.length, 0);
  assert.equal(provider.taskCalls.length, 0);
  assert.equal(state.messages.at(-1).text, "This repository is a thin ADE slice.");
  assert.equal(state.messages.at(-1).kind, "answer");
  assert.ok(eventStore.events.some((event) => event.type === "request.classified" && event.mode === "answer"));
  assert.ok(!eventStore.events.some((event) => event.type === "task.created"));
});

test("starting a work task creates exactly one card that owns exactly one Codex thread", async () => {
  const { runtime, provider, eventStore } = await runOneTask();

  const state = runtime.getState();
  assert.equal(state.tasks.length, 1);
  const [task] = state.tasks;
  assert.equal(task.status, "completed");
  assert.equal(task.threadId, "thread-1");
  assert.equal(provider.threadsByTask.size, 1);
  assert.equal(provider.taskCalls.length, 1);
  assert.ok(eventStore.events.some((event) => event.type === "task.created" && event.taskId === task.id));
  const types = eventStore.events.map((event) => event.type);
  assert.equal(types.filter((type) => type === "task.thread.attached").length, 1);
  assert.ok(
    types.indexOf("task.thread.attached") < types.indexOf("task.completed"),
    "the owning thread is inspectable before the task reports its result"
  );
});

test("internal Codex subagent activity stays inside the owning card instead of creating new cards", async () => {
  const { runtime, eventStore } = await runOneTask({
    respond: async ({ onActivity }) => {
      await onActivity({ kind: "subagent", text: "Started an internal Codex subagent step: codex exec review" });
      await onActivity({ kind: "subagent", text: "An internal Codex subagent step finished." });
      await onActivity({ kind: "internal", text: "Completed a read-only Project inspection step." });
      return {
        status: "completed",
        summary: "Reviewed the repository with internal helper steps.",
        activities: ["Reported the result."],
        question: null,
        detail: LONG_DETAIL
      };
    }
  });

  const state = runtime.getState();
  assert.equal(state.tasks.length, 1);
  const [task] = state.tasks;
  const subagentActivity = task.activity.filter((entry) => entry.kind === "subagent");
  assert.equal(subagentActivity.length, 2);
  const activityEvents = eventStore.events.filter((event) => event.type === "task.activity");
  assert.ok(activityEvents.length >= 4);
  assert.ok(activityEvents.every((event) => event.taskId === task.id));
  assert.equal(eventStore.events.filter((event) => event.type === "task.created").length, 1);
  assert.equal(task.internalSteps, 3, "only provider mechanics count as internal steps");
});

test("a Coordinator Turn cannot fan out to several cards unless the owner asked for parallel work", async () => {
  const twoTasks = () => ({
    mode: "delegate",
    message: "Starting work.",
    tasks: [
      { title: "First", objective: "Do the first thing", acceptanceCriteria: ["First done"] },
      { title: "Second", objective: "Do the second thing", acceptanceCriteria: ["Second done"] }
    ]
  });

  const clamped = createRuntime({ plan: twoTasks });
  await clamped.runtime.initialize();
  const accepted = await clamped.runtime.submitRequest("Review this repository and report one result.");
  await clamped.runtime.waitForIdle();
  const clampedState = clamped.runtime.getState();
  assert.equal(accepted.taskIds.length, 1);
  assert.equal(clampedState.tasks.length, 1);
  assert.equal(clamped.provider.threadsByTask.size, 1);
  assert.ok(clamped.eventStore.events.some((event) => event.type === "plan.clamped"));
  assert.match(clampedState.messages.find((message) => message.kind === "dispatch").text, /kept this to one task card/);

  const requested = createRuntime({ plan: twoTasks });
  await requested.runtime.initialize();
  const both = await requested.runtime.submitRequest("Run two parallel tasks over this repository.");
  await requested.runtime.waitForIdle();
  assert.equal(both.taskIds.length, 2);
  assert.equal(requested.runtime.getState().tasks.length, 2);
  assert.ok(!requested.eventStore.events.some((event) => event.type === "plan.clamped"));
});

test("a collapsed card keeps a concise status while the long result stays in the task transcript", async () => {
  const { runtime } = await runOneTask();

  const [task] = runtime.getState().tasks;
  assert.ok(task.summary.length <= 200);
  assert.ok(!task.summary.includes(LONG_DETAIL));
  assert.ok(task.activity.length <= 8);
  const lastTranscriptEntry = task.transcript.at(-1);
  assert.equal(lastTranscriptEntry.role, "task");
  assert.equal(lastTranscriptEntry.text, LONG_DETAIL);
});

test("a completed task produces one concise Coordinator summary that points at its card", async () => {
  const { runtime, eventStore } = await runOneTask();

  const state = runtime.getState();
  const [task] = state.tasks;
  const summaries = state.messages.filter((message) => message.kind === "task-summary");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].taskId, task.id);
  assert.match(summaries[0].text, /Repository review/);
  assert.match(summaries[0].text, /Reviewed the repository/);
  assert.ok(!summaries[0].text.includes(LONG_DETAIL));
  assert.ok(eventStore.events.some((event) => event.type === "coordinator.summarized" && event.taskId === task.id));
});

test("a follow-up message continues the same Codex thread and stays inside the card", async () => {
  const { runtime, provider, eventStore } = await runOneTask();
  const [created] = runtime.getState().tasks;

  const accepted = await runtime.sendTaskMessage(created.id, "Also list the riskiest file.", "task card");
  await runtime.waitForIdle();

  const state = runtime.getState();
  const task = state.tasks.find((candidate) => candidate.id === created.id);
  assert.equal(accepted.taskId, created.id);
  assert.equal(provider.taskCalls.length, 2);
  assert.deepEqual(provider.taskCalls.map((call) => call.taskId), [created.id, created.id]);
  assert.equal(provider.taskCalls[1].message, "Also list the riskiest file.");
  assert.equal(provider.taskCalls[1].threadId, "thread-1");
  assert.equal(provider.threadsByTask.size, 1);
  assert.equal(state.tasks.length, 1);
  assert.ok(task.transcript.some((entry) => entry.role === "owner" && entry.text === "Also list the riskiest file."));
  assert.ok(!state.messages.some((message) => message.text.includes("Also list the riskiest file.")));
  assert.ok(eventStore.events.some((event) => event.type === "task.message.sent" && event.taskId === created.id));
});

test("a clarification is answerable from the Coordinator panel and resumes the one owning thread", async () => {
  const { runtime, provider, eventStore } = await runOneTask({
    respond: async ({ message }) => (message
      ? {
          status: "completed",
          summary: `Continued with the owner decision: ${message}`,
          activities: ["Applied the owner decision."],
          question: null,
          detail: LONG_DETAIL
        }
      : {
          status: "needs_clarification",
          summary: "Two options are viable and need one owner decision.",
          activities: ["Compared option A with option B."],
          question: "Should I prioritize option A or option B?",
          detail: null
        })
  });

  const waiting = runtime.getState().tasks[0];
  const question = runtime.getState().questions.find((candidate) => candidate.status === "open");
  assert.equal(waiting.status, "waiting");
  assert.equal(question.taskId, waiting.id);

  const accepted = await runtime.answerQuestion(question.id, "Prioritize option B.", "coordinator");
  await runtime.waitForIdle();

  const state = runtime.getState();
  const task = state.tasks.find((candidate) => candidate.id === waiting.id);
  const answered = state.questions.find((candidate) => candidate.id === question.id);
  assert.equal(accepted.taskId, waiting.id);
  assert.equal(answered.status, "answered");
  assert.equal(answered.answeredFrom, "Coordinator");
  assert.equal(task.status, "completed");
  assert.equal(task.questionId, null);
  assert.equal(provider.taskCalls.length, 2);
  assert.equal(provider.threadsByTask.size, 1);
  assert.ok(state.messages.some((message) => message.role === "owner" && message.text.includes("Prioritize option B.")));
  assert.ok(eventStore.events.some((event) => event.type === "question.answered" && event.source === "Coordinator"));

  await assert.rejects(
    runtime.answerQuestion(question.id, "A conflicting second answer.", "task card"),
    (error) => error.statusCode === 409 && /already answered/.test(error.message)
  );
});

test("several tasks run concurrently while the Coordinator still answers a direct question", async () => {
  const { runtime, provider } = createRuntime({
    plan: (request) => (request.endsWith("?")
      ? { mode: "answer", message: "Two tasks are running.", tasks: [] }
      : {
          mode: "delegate",
          message: "Starting the two parallel tasks you asked for.",
          tasks: [
            { title: "Architecture map", objective: "Map the architecture", acceptanceCriteria: ["Return a map"] },
            { title: "Risk review", objective: "List risks", acceptanceCriteria: ["Return risks"] }
          ]
        }),
    respond: async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        status: "completed",
        summary: "Finished the bounded investigation.",
        activities: ["Inspected the Project."],
        question: null,
        detail: LONG_DETAIL
      };
    }
  });
  await runtime.initialize();

  await runtime.submitRequest("Run two parallel tasks: map the architecture and list risks.");
  const answered = await runtime.submitRequest("What is running right now?");
  await runtime.waitForIdle();

  const state = runtime.getState();
  assert.equal(answered.mode, "answer");
  assert.equal(state.tasks.length, 2);
  assert.equal(provider.maximumActiveTaskTurns, 2);
  assert.equal(provider.threadsByTask.size, 2);
  assert.deepEqual(state.tasks.map((task) => task.status), ["completed", "completed"]);
  assert.ok(state.messages.some((message) => message.kind === "answer" && message.text === "Two tasks are running."));
  assert.equal(state.messages.filter((message) => message.kind === "task-summary").length, 2);
});

test("a failed provider turn becomes visible card state and a durable event", async () => {
  const { runtime, eventStore } = await runOneTask({
    respond: async () => { throw new Error("fixture provider unavailable"); }
  });

  const [task] = runtime.getState().tasks;
  assert.equal(task.status, "failed");
  assert.match(task.summary, /fixture provider unavailable/);
  assert.ok(eventStore.events.some((event) => event.type === "task.failed" && event.taskId === task.id));
});

test("a busy task rejects a second concurrent turn on its own thread", async () => {
  const { runtime } = createRuntime({
    respond: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        status: "completed",
        summary: "Finished.",
        activities: ["Inspected the Project."],
        question: null,
        detail: LONG_DETAIL
      };
    }
  });
  await runtime.initialize();
  const accepted = await runtime.submitRequest("Review this repository and report one result.");

  await assert.rejects(
    runtime.sendTaskMessage(accepted.taskIds[0], "Squeeze this in now.", "task card"),
    (error) => error.statusCode === 409
  );
  await runtime.waitForIdle();
});

test("a restart leaves an interrupted task's outcome unknown instead of calling it failed", async () => {
  const { runtime, eventStore } = await runOneTask();
  const snapshot = eventStore.state;
  snapshot.tasks[0].status = "working";
  snapshot.tasks[0].summary = "Reading the bounded Project context.";

  const restarted = createRuntime({ restoredState: snapshot });
  const restoredState = await restarted.runtime.initialize();
  const [task] = restoredState.tasks;
  assert.equal(task.status, "unknown");
  assert.match(task.summary, /outcome is unknown/);
  assert.ok(restarted.eventStore.events.some((event) => event.type === "task.outcome.unknown" && event.taskId === task.id));
  assert.ok(!restarted.eventStore.events.some((event) => event.type === "task.failed"));
  assert.equal(runtime.getState().tasks[0].status, "completed");
});

test("a follow-up after a task stopped is recorded as an owner-initiated reopen", async () => {
  const { runtime, eventStore } = await runOneTask();
  const [task] = runtime.getState().tasks;

  await runtime.sendTaskMessage(task.id, "One more thing, please.", "task card");
  await runtime.waitForIdle();

  assert.ok(eventStore.events.some((event) => event.type === "task.reopened" && event.taskId === task.id));
  assert.equal(runtime.getState().tasks[0].transcript.filter((entry) => entry.role === "task").length, 2);
});

test("an unrecognized message source is rejected before it reaches durable state", async () => {
  const { runtime } = await runOneTask();
  const [task] = runtime.getState().tasks;

  await assert.rejects(
    runtime.sendTaskMessage(task.id, "Who is asking?", "anonymous"),
    (error) => error.statusCode === 400
  );
  assert.equal(runtime.getState().tasks[0].transcript.filter((entry) => entry.role === "owner").length, 0);
});

test("task and thread identity plus lifecycle events are locally inspectable", async () => {
  const { runtime } = await runOneTask();
  const [task] = runtime.getState().tasks;

  const inspection = runtime.inspectTask(task.id);
  assert.equal(inspection.task.id, task.id);
  assert.equal(inspection.task.threadId, "thread-1");
  assert.ok(inspection.events.length >= 3);
  assert.ok(inspection.events.every((event) => event.taskId === task.id));
  assert.ok(inspection.events.some((event) => event.type === "task.completed" && event.threadId === "thread-1"));
  assert.throws(() => runtime.inspectTask("task-missing"), (error) => error.statusCode === 404);
});

test("the filesystem store appends JSONL events and replaces the restorable snapshot", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "ade-event-store-"));
  try {
    const store = new EventStore(temporaryRoot);
    await store.initialize();
    await store.append({ id: "event-1", runId: "run-1" }, { version: 2, value: "first" });
    await store.append({ id: "event-2", runId: "run-1" }, { version: 2, value: "second" });
    await store.flush();

    const restored = await store.loadState();
    const lines = (await readFile(path.join(temporaryRoot, "runs", "run-1.jsonl"), "utf8")).trim().split("\n");
    assert.equal(restored.value, "second");
    assert.deepEqual(lines.map((line) => JSON.parse(line).id), ["event-1", "event-2"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

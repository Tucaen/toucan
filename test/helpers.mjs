import { AdeRuntime } from "../src/runtime.mjs";

/** A result long enough to prove it never reaches a collapsed card or the Coordinator line. */
export const LONG_DETAIL = `Detailed finding: ${"the full worker result continues. ".repeat(20)}`;

export class MemoryEventStore {
  constructor(initialState = null) {
    this.state = initialState;
    this.events = [];
  }

  async initialize() {}
  async loadState() { return this.state; }

  async append(event, state) {
    this.events.push(structuredClone(event));
    this.state = structuredClone(state);
  }

  async flush() {}
}

/** Provider fake that records how many Codex threads each task would own. */
export class FakeProvider {
  constructor({ plan, respond } = {}) {
    this.plan = plan ?? (() => ({
      mode: "delegate",
      message: "Starting one task; I will check its acceptance criteria.",
      tasks: [{ title: "Repository review", objective: "Review the repository", acceptanceCriteria: ["Report the result"] }]
    }));
    this.respond = respond ?? (async () => ({
      status: "completed",
      summary: "Reviewed the repository and reported one result.",
      activities: ["Read the bounded Project context."],
      question: null,
      detail: LONG_DETAIL
    }));
    this.coordinateCalls = [];
    this.taskCalls = [];
    this.threadsByTask = new Map();
    this.activeTaskTurns = 0;
    this.maximumActiveTaskTurns = 0;
  }

  async coordinate(input) {
    this.coordinateCalls.push(input);
    return { ...this.plan(input.request, input), model: "test-model" };
  }

  async runTask(input) {
    this.taskCalls.push({ taskId: input.task.id, message: input.message, threadId: input.task.threadId });
    this.activeTaskTurns += 1;
    this.maximumActiveTaskTurns = Math.max(this.maximumActiveTaskTurns, this.activeTaskTurns);
    const threadId = this.threadsByTask.get(input.task.id) ?? `thread-${this.threadsByTask.size + 1}`;
    this.threadsByTask.set(input.task.id, threadId);
    await input.onThread?.(threadId);
    try {
      const result = await this.respond(input);
      return { ...result, threadId, model: "test-model" };
    } finally {
      this.activeTaskTurns -= 1;
    }
  }
}

/**
 * Minimal DOM stand-in: enough for the client's render path, with no browser dependency.
 * `public/app.js` is a module singleton, so one test file may drive one client instance.
 */
export function installDom(state) {
  const handlers = new Map();
  const appElement = {
    innerHTML: "",
    dataset: {},
    addEventListener(type, handler) { handlers.set(type, handler); },
    querySelector() { return null; }
  };
  globalThis.document = {
    activeElement: null,
    querySelector(selector) { return selector === "#app" ? appElement : null; }
  };
  globalThis.localStorage = { getItem: () => "canvas", setItem() {} };
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.fetch = async () => ({ ok: true, json: async () => structuredClone(state) });
  globalThis.EventSource = class {
    addEventListener() {}
  };
  return { appElement, handlers };
}

export function clickEvent(selector, dataset) {
  return { target: { closest: (candidate) => (candidate === selector ? { dataset } : null) } };
}

export async function waitForRender(appElement) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (appElement.innerHTML.includes("task-node")) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("The client never rendered a task card.");
}

export function createRuntime({ restoredState = null, ...providerOptions } = {}) {
  const provider = new FakeProvider(providerOptions);
  const eventStore = new MemoryEventStore(restoredState);
  const runtime = new AdeRuntime({
    projectPath: process.cwd(),
    projectName: "fixture",
    provider,
    eventStore,
    contextBuilder: async () => ({ root: process.cwd(), files: ["README.md"], truncated: false, snippets: [] })
  });
  return { runtime, provider, eventStore };
}

export async function runOneTask(providerOptions) {
  const harness = createRuntime(providerOptions);
  await harness.runtime.initialize();
  await harness.runtime.submitRequest("Review this repository and report one result.");
  await harness.runtime.waitForIdle();
  return harness;
}

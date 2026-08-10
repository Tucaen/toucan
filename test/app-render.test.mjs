import assert from "node:assert/strict";
import test from "node:test";
import { LONG_DETAIL, clickEvent, createRuntime, installDom, waitForRender } from "./helpers.mjs";

const SUBAGENT_STEP = "Started an internal agent step: codex exec review";

test("the task canvas renders concise cards and opens one card as a thread surface", async () => {
  const { runtime } = createRuntime({
    respond: async ({ onActivity }) => {
      await onActivity({ kind: "subagent", text: SUBAGENT_STEP });
      return {
        status: "completed",
        summary: "Reviewed the repository and reported one result.",
        activities: ["Read the bounded Project context."],
        question: null,
        detail: LONG_DETAIL
      };
    }
  });
  await runtime.initialize();
  await runtime.submitRequest("Review this repository and report one result.");
  await runtime.waitForIdle();
  const state = runtime.getState();
  const [task] = state.tasks;

  const { appElement, handlers } = installDom(state);
  await import("../public/app.js");
  await waitForRender(appElement);

  const collapsed = appElement.innerHTML;
  assert.match(collapsed, /Repository review/);
  assert.match(collapsed, /Reviewed the repository and reported one result\./);
  assert.match(collapsed, /Read the bounded Project context\./);
  assert.match(collapsed, /Completed/);
  assert.ok(!collapsed.includes(LONG_DETAIL), "a collapsed card must not carry the long final response");
  assert.ok(!collapsed.includes(SUBAGENT_STEP), "internal agent activity must not pollute the canvas");
  assert.ok(!collapsed.includes("task-node open"));

  handlers.get("click")(clickEvent("[data-open-task]", { openTask: task.id }));
  const opened = appElement.innerHTML;
  assert.match(opened, /task-node open/);
  assert.ok(opened.includes(LONG_DETAIL), "an opened card exposes its transcript");
  assert.ok(opened.includes(SUBAGENT_STEP), "an opened card exposes its internal steps");
  assert.match(opened, /1 internal step · most recent below · never a separate card/);
  assert.match(opened, /data-task-form/);
  assert.match(opened, /Same Codex thread/);
  assert.match(opened, /thread-1/);
  assert.ok(opened.includes(task.id));

  handlers.get("click")(clickEvent("[data-open-task]", { openTask: task.id }));
  assert.ok(!appElement.innerHTML.includes("task-node open"), "clicking again collapses the card");
});

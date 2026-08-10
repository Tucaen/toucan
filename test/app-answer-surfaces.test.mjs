import assert from "node:assert/strict";
import test from "node:test";
import { createRuntime, installDom, waitForRender } from "./helpers.mjs";

test("a waiting task can be answered from its collapsed card and from the Coordinator panel", async () => {
  const { runtime } = createRuntime({
    respond: async () => ({
      status: "needs_clarification",
      summary: "Two options are viable and need one owner decision.",
      activities: ["Compared option A with option B."],
      question: "Should I prioritize option A or option B?",
      detail: null
    })
  });
  await runtime.initialize();
  await runtime.submitRequest("Review this repository and report one result.");
  await runtime.waitForIdle();

  const { appElement } = installDom(runtime.getState());
  await import("../public/app.js");
  await waitForRender(appElement);

  const html = appElement.innerHTML;
  const cardForms = html.match(/data-answer-form data-question="[^"]+" data-source="task card"/g) ?? [];
  const panelForms = html.match(/data-answer-form data-question="[^"]+" data-source="coordinator"/g) ?? [];
  assert.equal(cardForms.length, 1, "the originating card offers the answer control");
  assert.equal(panelForms.length, 1, "the Coordinator panel offers the same answer control");
  assert.match(html, /Should I prioritize option A or option B\?/);
});

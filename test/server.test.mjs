import assert from "node:assert/strict";
import test from "node:test";
import { start } from "../src/server.mjs";

class MemoryEventStore {
  async initialize() {}
  async loadState() { return null; }
  async append() {}
  async flush() {}
}

test("the local server exposes the configured Project state and Variant A application shell", async () => {
  const provider = {
    coordinate() { throw new Error("not used"); },
    runSession() { throw new Error("not used"); }
  };
  const { server, url } = await start({
    projectPath: process.cwd(),
    projectName: "ADE fixture",
    port: 0,
    provider,
    eventStore: new MemoryEventStore()
  });
  try {
    const stateResponse = await fetch(`${url}/api/state`);
    const state = await stateResponse.json();
    assert.equal(stateResponse.status, 200);
    assert.equal(state.project.name, "ADE fixture");

    const appResponse = await fetch(url);
    const html = await appResponse.text();
    assert.equal(appResponse.status, 200);
    assert.match(html, /<title>ADE · Project canvas<\/title>/);
    assert.match(html, /src="\/app\.js"/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

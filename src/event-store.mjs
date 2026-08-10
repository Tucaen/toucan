import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export class EventStore {
  constructor(rootPath) {
    this.rootPath = rootPath;
    this.runsPath = path.join(rootPath, "runs");
    this.statePath = path.join(rootPath, "state.json");
    this.writeChain = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.runsPath, { recursive: true });
  }

  async loadState() {
    try {
      return JSON.parse(await readFile(this.statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  append(event, state) {
    const serializedState = `${JSON.stringify(state, null, 2)}\n`;
    this.writeChain = this.writeChain.then(async () => {
      await this.initialize();
      const runFile = path.join(this.runsPath, `${event.runId}.jsonl`);
      await appendFile(runFile, `${JSON.stringify(event)}\n`, "utf8");
      const temporaryStatePath = `${this.statePath}.tmp`;
      await writeFile(temporaryStatePath, serializedState, "utf8");
      await rename(temporaryStatePath, this.statePath);
    });
    return this.writeChain;
  }

  async flush() {
    await this.writeChain;
  }
}

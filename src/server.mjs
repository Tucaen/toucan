import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexProvider } from "./codex-provider.mjs";
import { EventStore } from "./event-store.mjs";
import { AdeRuntime } from "./runtime.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(sourceDirectory, "../public");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function json(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": CONTENT_TYPES[".json"] });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error("Request body is too large."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 });
  }
}

async function serveStatic(url, response) {
  const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const normalized = path.normalize(relativePath);
  const absolutePath = path.resolve(publicDirectory, normalized);
  if (!absolutePath.startsWith(`${publicDirectory}${path.sep}`) && absolutePath !== path.join(publicDirectory, "index.html")) {
    json(response, 404, { error: "Not found" });
    return;
  }
  try {
    const body = await readFile(absolutePath);
    response.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(absolutePath)] ?? "application/octet-stream" });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") json(response, 404, { error: "Not found" });
    else throw error;
  }
}

export function createAdeServer(runtime) {
  const streams = new Set();
  const unsubscribe = runtime.subscribe((event, state) => {
    const payload = `event: state\ndata: ${JSON.stringify({ event, state })}\n\n`;
    for (const response of streams) response.write(payload);
  });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/api/state") {
        json(response, 200, runtime.getState());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive"
        });
        response.write(`event: state\ndata: ${JSON.stringify({ event: null, state: runtime.getState() })}\n\n`);
        streams.add(response);
        request.on("close", () => streams.delete(response));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/requests") {
        const body = await readJson(request);
        json(response, 202, await runtime.submitRequest(body.request));
        return;
      }
      const taskMessageMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/messages$/);
      if (request.method === "POST" && taskMessageMatch) {
        const body = await readJson(request);
        json(response, 202, await runtime.sendTaskMessage(decodeURIComponent(taskMessageMatch[1]), body.message, body.source));
        return;
      }
      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (request.method === "GET" && taskMatch) {
        json(response, 200, runtime.inspectTask(decodeURIComponent(taskMatch[1])));
        return;
      }
      const questionMatch = url.pathname.match(/^\/api\/questions\/([^/]+)\/answer$/);
      if (request.method === "POST" && questionMatch) {
        const body = await readJson(request);
        json(response, 202, await runtime.answerQuestion(decodeURIComponent(questionMatch[1]), body.answer, body.source));
        return;
      }
      if (request.method === "GET") {
        await serveStatic(url, response);
        return;
      }
      json(response, 404, { error: "Not found" });
    } catch (error) {
      json(response, error.statusCode ?? 500, { error: error.message ?? "Internal server error" });
    }
  });
  server.on("close", unsubscribe);
  return server;
}

function parseArguments(argumentsList) {
  const result = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === "--project") result.projectPath = argumentsList[++index];
    else if (argumentsList[index] === "--port") result.port = Number(argumentsList[++index]);
    else if (argumentsList[index] === "--name") result.projectName = argumentsList[++index];
    else if (argumentsList[index] === "--data") result.dataPath = argumentsList[++index];
  }
  return result;
}

export async function start(options = {}) {
  const args = parseArguments(process.argv.slice(2));
  const projectPath = path.resolve(options.projectPath ?? args.projectPath ?? process.env.ADE_PROJECT_PATH ?? process.cwd());
  const projectName = options.projectName ?? args.projectName ?? process.env.ADE_PROJECT_NAME ?? path.basename(projectPath);
  const port = options.port ?? args.port ?? Number(process.env.ADE_PORT ?? 4319);
  const dataRoot = path.resolve(options.dataPath ?? args.dataPath ?? process.env.ADE_DATA_PATH ?? path.join(process.cwd(), ".ade"));
  const projectKey = createHash("sha256").update(projectPath.toLowerCase()).digest("hex").slice(0, 12);
  const projectDataPath = path.join(dataRoot, "projects", projectKey);
  await access(path.join(projectPath, ".git"));
  const provider = options.provider ?? new CodexProvider();
  const store = options.eventStore ?? new EventStore(projectDataPath);
  const runtime = options.runtime ?? new AdeRuntime({ projectPath, projectName, provider, eventStore: store });
  await runtime.initialize();
  const server = createAdeServer(runtime);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, runtime, dataPath: projectDataPath, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start()
    .then(({ url, runtime, dataPath }) => {
      console.log(`ADE vertical slice: ${url}`);
      console.log(`Project: ${runtime.getState().project.path}`);
      console.log(`Events: ${path.join(dataPath, "runs")}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

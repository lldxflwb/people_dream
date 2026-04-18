import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { BlacklistRule, CapturePayload } from "./types.js";
import { Store } from "./store.js";

const DEFAULT_ADDR = "0.0.0.0:9095";
const DEFAULT_DATA_DIR = "data";
const STATIC_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "public");
const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

interface PauseRequest {
  paused: boolean;
}

interface BlacklistRequest {
  kind: string;
  pattern: string;
  mode: string;
}

interface DreamRequest {
  day: string;
}

function parseListenAddress(addr: string): { host: string; port: number } {
  const trimmed = addr.trim();
  const index = trimmed.lastIndexOf(":");
  if (index <= 0) {
    throw new Error(`invalid addr: ${addr}`);
  }
  const host = trimmed.slice(0, index);
  const port = Number(trimmed.slice(index + 1));
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid addr: ${addr}`);
  }
  return { host, port };
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  setCorsHeaders(response);
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

async function readRequestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw) as unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function parseCapturePayload(input: unknown): CapturePayload {
  if (!isObject(input)) {
    throw new Error("capture payload must be an object");
  }
  return {
    url: asString(input.url),
    title: asString(input.title),
    textContent: asString(input.textContent),
    excerpt: asString(input.excerpt),
    capturedAt: asString(input.capturedAt),
    dwellMs: asNumber(input.dwellMs),
    scrollDepth: asNumber(input.scrollDepth),
    reason: asString(input.reason),
    pageSignals: asStringArray(input.pageSignals)
  };
}

function parsePauseRequest(input: unknown): PauseRequest {
  if (!isObject(input) || typeof input.paused !== "boolean") {
    throw new Error("pause payload must include paused:boolean");
  }
  return { paused: input.paused };
}

function parseBlacklistRequest(input: unknown): BlacklistRequest {
  if (!isObject(input)) {
    throw new Error("blacklist payload must be an object");
  }
  return {
    kind: asString(input.kind),
    pattern: asString(input.pattern),
    mode: asString(input.mode)
  };
}

function parseDreamRequest(input: unknown): DreamRequest {
  if (!isObject(input)) {
    return { day: "" };
  }
  return {
    day: asString(input.day)
  };
}

async function serveStatic(response: ServerResponse, requestPath: string): Promise<void> {
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const safePath = normalize(normalizedPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(STATIC_ROOT, safePath);
  try {
    const content = await readFile(filePath);
    response.statusCode = 200;
    response.setHeader("Content-Type", CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream");
    response.end(content);
  } catch {
    response.statusCode = 404;
    response.end("404 page not found");
  }
}

const args = parseArgs({
  options: {
    addr: { type: "string", default: DEFAULT_ADDR },
    "data-dir": { type: "string", default: DEFAULT_DATA_DIR }
  }
});

const store = new Store(args.values["data-dir"]);
const { host, port } = parseListenAddress(args.values.addr);

const server = createServer(async (request, response) => {
  try {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.statusCode = 200;
      response.end();
      return;
    }

    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "GET" && requestUrl.pathname === "/api/state") {
      sendJson(response, 200, store.summarize(asString(requestUrl.searchParams.get("day"))));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/page-status") {
      sendJson(response, 200, store.pageStatus(asString(requestUrl.searchParams.get("url"))));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/capture") {
      const payload = parseCapturePayload(await readRequestBody(request));
      sendJson(response, 200, store.processCapture(payload));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/pause") {
      const payload = parsePauseRequest(await readRequestBody(request));
      sendJson(response, 200, store.updatePaused(payload.paused));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/blacklist") {
      const payload = parseBlacklistRequest(await readRequestBody(request));
      const kind: BlacklistRule["kind"] = payload.kind === "url" ? "url" : "domain";
      const mode: BlacklistRule["mode"] = payload.mode === "meta-only" ? "meta-only" : "drop";
      sendJson(response, 200, store.addBlacklistRule({ kind, pattern: payload.pattern, mode }));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/dream-report-tasks") {
      const payload = parseDreamRequest(await readRequestBody(request));
      sendJson(response, 202, store.createDreamReportTask(payload.day));
      return;
    }

    if (request.method === "GET" && requestUrl.pathname.startsWith("/api/dream-report-tasks/")) {
      const taskId = decodeURIComponent(requestUrl.pathname.slice("/api/dream-report-tasks/".length));
      sendJson(response, 200, store.getDreamReportTask(taskId));
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname.startsWith("/api/blacklist/")) {
      const ruleId = decodeURIComponent(requestUrl.pathname.slice("/api/blacklist/".length));
      sendJson(response, 200, store.deleteBlacklistRule(ruleId));
      return;
    }

    if (request.method === "DELETE" && requestUrl.pathname.startsWith("/api/resources/")) {
      const resourceId = decodeURIComponent(requestUrl.pathname.slice("/api/resources/".length));
      const requestedDay = asString(requestUrl.searchParams.get("day"));
      sendJson(response, 200, store.deleteResource(resourceId, requestedDay));
      return;
    }

    await serveStatic(response, requestUrl.pathname);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    const statusCode =
      message.includes("已经生成过")
        ? 409
        : message.includes("not found")
          ? 404
          : 500;
    sendJson(response, statusCode, {
      error: "server-error",
      message
    });
  }
});

server.listen(port, host, () => {
  console.log(`People Dream TS server running at http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}

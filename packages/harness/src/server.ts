// The harness over HTTP (README.md, The HTTP API):
//   POST /v1/ask   {"question": "...", "history": [{"role": "user"|"assistant", "content": "..."}]}
//                  → {"answer", "sources", "followups", "by", "tools", "ms"}; with "stream": true, server-sent events:
//                  `step` ({"name", "phase"}) while the research runs, then one `answer`.
//   GET  /health   → {"ok": true}
// PORT (8790) and HOST (127.0.0.1): put it behind your own proxy and rate limit before you open it to anyone, since every
// answer spends your model key and the data keys.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { start } from "./run.ts";

const BODY_MAX = 256 * 1024;
/** Answers in flight at once; more are refused with 429 (each one holds model and data calls for up to minutes) */
const IN_FLIGHT_MAX = Math.max(1, Number(process.env.HARNESS_IN_FLIGHT_MAX) || 4);

const run = start();
let inFlight = 0;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_MAX) throw new Error("too_large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
  if (req.method !== "POST" || path !== "/v1/ask") return send(res, 404, { error: "not_found" });
  let body: Record<string, unknown>;
  try {
    const b = await readBody(req);
    body = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch (err) {
    return send(res, (err as Error).message === "too_large" ? 413 : 400, { error: "bad_body" });
  }
  if (typeof body.question !== "string" || !body.question.trim()) return send(res, 400, { error: "bad_question" });
  if (inFlight >= IN_FLIGHT_MAX) return send(res, 429, { error: "busy" });
  inFlight++;
  // the asker hung up: every read and the model stop
  const left = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) left.abort();
  });
  const stream = body.stream === true;
  if (stream) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const event = (name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const answer = await run.harness.ask({
      question: body.question,
      chat: { history: Array.isArray(body.history) ? (body.history as never) : [] },
      signal: left.signal,
      ...(stream ? { onStep: (name: string, phase: "start" | "end") => event("step", { name, phase }) } : {}),
    });
    if (stream) {
      event("answer", answer);
      res.end();
    } else send(res, 200, answer);
  } finally {
    inFlight--;
  }
});

const port = Number(process.env.PORT) || 8790;
const host = process.env.HOST?.trim() || "127.0.0.1";
server.listen(port, host, () => process.stderr.write(`harness: listening on http://${host}:${port}\n`));
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    server.close();
    run.stop();
    process.exit(0);
  });

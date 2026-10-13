/**
 * Remote mode: serve MCP over Streamable HTTP so clients can connect by URL
 * (Claude Code `--transport http`, Cursor, claude.ai custom connectors, …).
 *
 *   GADGET_MCP_HTTP_PORT   Port (default 3333)
 *   GADGET_MCP_HTTP_HOST   Interface to bind (default 127.0.0.1 — local only)
 *   GADGET_MCP_HTTP_TOKEN  Shared secret. Required when binding to anything but localhost.
 *                          Send as "Authorization: Bearer <token>", or use the secret URL
 *                          /mcp/<token> for clients that can't set headers.
 */
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, requireConfig } from "./server.js";

const MAX_BODY = 4 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when the request carries the token in the Authorization header or the /mcp/<token> path. */
export function authorized(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
  if (bearer && safeEqual(bearer, token)) return true;
  const pathToken = /^\/mcp\/([^/?#]+)/.exec(req.url ?? "")?.[1];
  return !!pathToken && safeEqual(decodeURIComponent(pathToken), token);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

const rpcError = (message: string) => ({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

export function buildHttpHandler(token: string | undefined) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/health") return send(res, 200, { ok: true, app: process.env.GADGET_APP });
    if (path !== "/mcp" && !path.startsWith("/mcp/")) return send(res, 404, { error: "Not found. The MCP endpoint is /mcp" });
    if (!authorized(req, token)) return send(res, 401, rpcError("Unauthorized"));

    // Stateless: each POST gets a fresh server + transport, so there's no session to manage
    if (req.method !== "POST") {
      return send(res, 405, rpcError("Method not allowed. This server is stateless; use POST."));
    }

    let body: unknown;
    try { body = await readJson(req); }
    catch (err: any) { return send(res, 400, rpcError(err.message)); }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err: any) {
      if (!res.headersSent) send(res, 500, rpcError(err?.message ?? "Internal error"));
    }
  };
}

export function startHttpServer(): void {
  requireConfig();
  const port = Number(process.env.GADGET_MCP_HTTP_PORT || 3333);
  const host = process.env.GADGET_MCP_HTTP_HOST || "127.0.0.1";
  const token = process.env.GADGET_MCP_HTTP_TOKEN?.trim() || undefined;

  if (!LOOPBACK.has(host) && !token) {
    console.error(`Refusing to listen on ${host} without GADGET_MCP_HTTP_TOKEN — anyone who can reach it could use your Gadget API key.`);
    process.exit(1);
  }

  createHttpServer(buildHttpHandler(token)).listen(port, host, () => {
    const base = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    console.error(`Gadget MCP (${process.env.GADGET_APP}) listening on ${base}/mcp`);
    if (token) console.error(`Auth: "Authorization: Bearer <GADGET_MCP_HTTP_TOKEN>", or the secret URL ${base}/mcp/<token>`);
    else console.error("No GADGET_MCP_HTTP_TOKEN set — accepting local connections without auth.");
  });
}

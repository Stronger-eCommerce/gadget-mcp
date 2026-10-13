import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer as createHttpServer, Server } from "http";
import type { AddressInfo } from "net";

process.env.GADGET_APP = "test-app";
process.env.GADGET_API_KEY = "gsk-testkey12345";
process.env.GADGET_MCP_NO_UPDATE_CHECK = "1";

const { parseStart, handleLogsTool, _exec } = await import("../logs.js");
const { listPrompts, getPrompt } = await import("../prompts.js");
const { authorized, buildHttpHandler } = await import("../http.js");

// ── read_logs ─────────────────────────────────────────────────────────────────
describe("parseStart", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  it("understands relative times and ISO timestamps", () => {
    expect(parseStart(undefined, now)).toBe("2026-10-13T11:45:00.000Z");
    expect(parseStart("2h", now)).toBe("2026-10-13T10:00:00.000Z");
    expect(parseStart("1d", now)).toBe("2026-10-12T12:00:00.000Z");
    expect(parseStart("30min", now)).toBe("2026-10-13T11:30:00.000Z");
    expect(parseStart("2026-10-01T00:00:00Z", now)).toBe("2026-10-01T00:00:00.000Z");
    expect(parseStart("yesterday-ish", now)).toBeNull();
  });
});

describe("read_logs", () => {
  it("runs ggt with the app, env and filters, then searches, limits and redacts", async () => {
    const run = vi.spyOn(_exec, "run").mockResolvedValue({
      code: 0, stderr: "",
      stdout: [
        JSON.stringify({ level: "error", msg: "order 42 failed", email: "a@b.com" }),
        JSON.stringify({ level: "error", msg: "order 43 failed key gsk-testkey12345" }),
        "plain text line about order 44",
        JSON.stringify({ level: "info", msg: "unrelated" }),
      ].join("\n"),
    });
    process.env.GADGET_REDACT_FIELDS = "email";
    const res = await handleLogsTool("read_logs", { since: "1h", level: "error", search: "order", limit: 2, my_logs: true });
    delete process.env.GADGET_REDACT_FIELDS;

    const args = run.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(["logs", "--app", "test-app", "--env", "production", "--log-level", "error", "--json", "--my-logs"]));
    const out = JSON.parse(res!.content[0].text);
    expect(out.matched).toBe(3);
    expect(out.logs).toHaveLength(2); // latest 2
    expect(out.note).toContain("latest 2 of 3");
    expect(JSON.stringify(out.logs)).not.toContain("gsk-testkey12345");
    run.mockRestore();
  });

  it("explains how to log in when ggt isn't authenticated", async () => {
    const run = vi.spyOn(_exec, "run").mockResolvedValue({ code: 1, stdout: "", stderr: "You must be logged in to use this command" });
    const res = await handleLogsTool("read_logs", {});
    expect(res!.isError).toBe(true);
    expect(res!.content[0].text).toContain("npx ggt login");
    run.mockRestore();
  });

  it("validates inputs and ignores other tools", async () => {
    expect((await handleLogsTool("read_logs", { since: "nope" }))!.isError).toBe(true);
    expect((await handleLogsTool("read_logs", { level: "loud" }))!.isError).toBe(true);
    expect(await handleLogsTool("something_else", {})).toBeNull();
  });
});

// ── prompts ───────────────────────────────────────────────────────────────────
describe("prompts", () => {
  it("lists prompts with their arguments", () => {
    const names = listPrompts().map((p) => p.name);
    expect(names).toEqual(["explore_app", "debug_record", "audit_errors", "data_health"]);
  });

  it("fills in arguments and enforces required ones", () => {
    const p = getPrompt("debug_record", { model: "shopifyOrder", id: "42" });
    expect(p.messages[0].content.text).toContain("shopifyOrder 42");
    expect(p.messages[0].content.text).toContain('search "42"');
    expect(() => getPrompt("debug_record", { model: "x" })).toThrow("id");
    expect(() => getPrompt("nope")).toThrow("Unknown prompt");
  });
});

// ── HTTP mode ─────────────────────────────────────────────────────────────────
describe("authorized", () => {
  const req = (url: string, auth?: string) => ({ url, headers: auth ? { authorization: auth } : {} }) as any;
  it("accepts a bearer header or the secret path, and nothing else", () => {
    expect(authorized(req("/mcp"), undefined)).toBe(true);
    expect(authorized(req("/mcp", "Bearer s3cret"), "s3cret")).toBe(true);
    expect(authorized(req("/mcp/s3cret"), "s3cret")).toBe(true);
    expect(authorized(req("/mcp"), "s3cret")).toBe(false);
    expect(authorized(req("/mcp", "Bearer wrong"), "s3cret")).toBe(false);
    expect(authorized(req("/mcp/wrong"), "s3cret")).toBe(false);
  });
});

describe("HTTP server", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createHttpServer(buildHttpHandler("s3cret"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const rpc = (path: string, body: unknown, auth = true) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(auth ? { Authorization: "Bearer s3cret" } : {}) },
    body: JSON.stringify(body),
  });

  it("serves health without auth and rejects unauthenticated MCP calls", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect((await rpc("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, false)).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { headers: { Authorization: "Bearer s3cret" } })).status).toBe(405);
  });

  it("speaks MCP: initialize, list tools and prompts", async () => {
    const init = await rpc("/mcp", {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(init.status).toBe(200);
    const initBody = await init.json() as any;
    expect(initBody.result.serverInfo.name).toBe("test-app-gadget");
    expect(initBody.result.capabilities.prompts).toBeDefined();

    const tools = await (await rpc("/mcp/s3cret", { jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as any;
    const names = tools.result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["query_records", "export_records", "group_count", "read_logs"]));

    const prompts = await (await rpc("/mcp", { jsonrpc: "2.0", id: 3, method: "prompts/list" })).json() as any;
    expect(prompts.result.prompts.length).toBe(4);
  });
});

// ── Claude Code plugin ────────────────────────────────────────────────────────
describe("plugin manifest", async () => {
  const { readFileSync } = await import("fs");
  const plugin = JSON.parse(readFileSync(new URL("../../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

  it("matches the npm package version", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it("passes every user setting through to the server", () => {
    const env = plugin.mcpServers.gadget.env as Record<string, string>;
    for (const key of Object.keys(plugin.userConfig)) {
      expect(Object.values(env)).toContain(`\${user_config.${key}}`);
    }
    expect(plugin.userConfig.api_key.sensitive).toBe(true);
  });
});

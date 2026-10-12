/**
 * Generic Gadget MCP Server
 * Works with any Gadget app — no generated client required.
 *
 * ── CONFIG ──────────────────────────────────────────────────────────────────
 * Required env vars:
 *   GADGET_APP         App slug, e.g. "my-app"
 *   GADGET_API_KEY     Production API key from <app>.gadget.app/edit/settings/api-keys
 *
 * Optional:
 *   GADGET_ENVIRONMENT   "production" (default) | "development"
 *   GADGET_ALLOW_WRITES  "true" to enable create_record, update_record, run_action
 *   GADGET_ALLOW_DELETES "true" to enable delete_record (and delete actions via run_action)
 *   GADGET_AUDIT_LOG     JSONL file path; every executed write is appended to it
 *
 * ── REGISTER IN CLAUDE CODE ─────────────────────────────────────────────────
 *   claude mcp add my-app-gadget \
 *     -e GADGET_APP=my-app \
 *     -e GADGET_API_KEY=your_key \
 *     -- npx @stronger-ecommerce/gadget-mcp@latest
 *
 * ── REGISTER IN CURSOR (~/.cursor/mcp.json) ─────────────────────────────────
 *   { "mcpServers": { "my-app-gadget": { "command": "npx",
 *     "args": ["@stronger-ecommerce/gadget-mcp@latest"],
 *     "env": { "GADGET_APP": "my-app", "GADGET_API_KEY": "your_key" } } } }
 * ────────────────────────────────────────────────────────────────────────────
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { handleTool, getToolDefinitions } from "./tools.js";
import { checkForUpdate, currentVersion, updateNoticeForAgent } from "./update.js";

const GADGET_APP = process.env.GADGET_APP;
const GADGET_API_KEY = process.env.GADGET_API_KEY;

if (!GADGET_APP || !GADGET_API_KEY) {
  console.error("GADGET_APP and GADGET_API_KEY environment variables are required");
  process.exit(1);
}

const server = new Server(
  { name: `${GADGET_APP}-gadget`, version: currentVersion() },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolDefinitions() }));

// Update notice for the agent — appended to the first tool result after an update is found,
// since stderr is rarely visible to users when the server runs inside an editor.
let pendingUpdateNotice: string | null = null;

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await handleTool(name, (args ?? {}) as Record<string, any>);
  if (pendingUpdateNotice) {
    result.content.push({ type: "text", text: pendingUpdateNotice });
    pendingUpdateNotice = null;
  }
  return result;
});

// fire-and-forget; prints to stderr so MCP stdio is unaffected
checkForUpdate().then((info) => {
  if (info) pendingUpdateNotice = updateNoticeForAgent(info);
});

const transport = new StdioServerTransport();
await server.connect(transport);

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
 *   GADGET_ENVIRONMENT "production" (default) | "development"
 *
 * ── REGISTER IN CLAUDE CODE ─────────────────────────────────────────────────
 *   claude mcp add my-app-gadget \
 *     -e GADGET_APP=my-app \
 *     -e GADGET_API_KEY=your_key \
 *     -- npx @stronger-ecommerce/gadget-mcp
 *
 * ── REGISTER IN CURSOR (~/.cursor/mcp.json) ─────────────────────────────────
 *   { "mcpServers": { "my-app-gadget": { "command": "npx",
 *     "args": ["@stronger-ecommerce/gadget-mcp"],
 *     "env": { "GADGET_APP": "my-app", "GADGET_API_KEY": "your_key" } } } }
 * ────────────────────────────────────────────────────────────────────────────
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { handleTool, TOOL_DEFINITIONS } from "./tools.js";
import { checkForUpdate } from "./setup.js";

const GADGET_APP = process.env.GADGET_APP;
const GADGET_API_KEY = process.env.GADGET_API_KEY;

if (!GADGET_APP || !GADGET_API_KEY) {
  console.error("GADGET_APP and GADGET_API_KEY environment variables are required");
  process.exit(1);
}

const server = new Server(
  { name: `${GADGET_APP}-gadget`, version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleTool(name, (args ?? {}) as Record<string, any>);
});

checkForUpdate(); // fire-and-forget; prints to stderr so MCP stdio is unaffected

const transport = new StdioServerTransport();
await server.connect(transport);

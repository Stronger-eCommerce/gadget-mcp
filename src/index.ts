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
 *   (see README for the full list, and `gadget-mcp serve` for HTTP mode)
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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, requireConfig } from "./server.js";

requireConfig();
await createServer().connect(new StdioServerTransport());

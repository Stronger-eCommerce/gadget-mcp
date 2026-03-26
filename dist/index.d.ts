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
 *   # For a second app:
 *   claude mcp add my-other-app-gadget \
 *     -e GADGET_APP=my-other-app \
 *     -e GADGET_API_KEY=other_key \
 *     -- npx @stronger-ecommerce/gadget-mcp
 *
 * ── REGISTER IN CURSOR (~/.cursor/mcp.json) ─────────────────────────────────
 *   {
 *     "mcpServers": {
 *       "app-one-gadget": {
 *         "command": "npx",
 *         "args": ["@stronger-ecommerce/gadget-mcp"],
 *         "env": { "GADGET_APP": "my-first-app", "GADGET_API_KEY": "your_key" }
 *       },
 *       "app-two-gadget": {
 *         "command": "npx",
 *         "args": ["@stronger-ecommerce/gadget-mcp"],
 *         "env": { "GADGET_APP": "my-second-app", "GADGET_API_KEY": "other_key" }
 *       }
 *     }
 *   }
 * ────────────────────────────────────────────────────────────────────────────
 */
export {};
//# sourceMappingURL=index.d.ts.map
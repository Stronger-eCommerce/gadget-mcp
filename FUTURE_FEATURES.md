# Future features

Ideas and planned work for **gadget-mcp** and related tooling. Not a commitment or timeline — a scratchpad for maintainers and contributors.

---

## Logs ingestion (Claude / Cursor can “read” app logs)

**Goal:** Let agents inspect Gadget app logs during debugging and support, without a first-class “logs API” in MCP today.

**Context (Gadget support, Mar 2026):** There isn’t a great single place to “talk to” logs from yet. A practical path is the **ggt** CLI:

- [`ggt logs`](https://docs.gadget.dev/reference/ggt#ggt-logs) with a time window, e.g. `ggt logs --start 2026-03-12T10:00:00Z`
- **JSON for machines:** pipe or capture live logs with `--json` (e.g. to a file the agent can read)

**Possible shapes:**

| Approach                  | Notes                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Cursor / Claude skill** | Document workflow: run `ggt logs` in terminal, point the agent at the JSON file or paste output. Low implementation cost. |
| **MCP tool**              | Wrap or orchestrate log fetch (if feasible without duplicating `ggt`); needs auth/env story aligned with Gadget CLI.      |
| **Hybrid**                | Skill for humans + optional future MCP tool if the platform exposes something cleaner later.                              |

**Open questions:** Where credentials / app context live for `ggt` vs `GADGET_API_KEY` for this server; rate limits and log volume for large windows.

---

## Add your idea

Open an issue or PR that extends this file with a short **goal**, **constraints**, and **possible approaches** — same structure as above.

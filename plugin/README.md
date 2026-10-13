# Gadget MCP

Query, debug and (optionally) change data in any [Gadget](https://gadget.dev) app from Claude. This is a community plugin by [Stronger eCommerce](https://strongerecommerce.com) and isn't affiliated with or endorsed by Gadget.

![Gadget MCP icon](./icon.svg)

## What you get

- **Read tools**: browse the schema, query, count and group records, export up to 100k records to CSV/JSON, run read-only GraphQL, and read recent app logs.
- **Optional write tools**: off unless you turn them on. They create, update, bulk-update and delete records or run actions, and each takes `dry_run` to preview a change first. You can limit them to specific models.
- **Privacy controls**: on by default, personal data (emails, phones, names, addresses) is replaced with `[REDACTED]` in every result.
- **A skill and prompts** that teach Claude a safe read → preview → confirm workflow, plus ready-made prompts to explore an app, debug a record, audit errors and check data health.

## Setup

```
/plugin install gadget-mcp --marketplace Stronger-eCommerce/gadget-mcp@release
```

When you enable the plugin, Claude Code asks for:

| Setting | Notes |
|---|---|
| Gadget app slug | e.g. `my-app` for `my-app.gadget.app` |
| Gadget API key | Stored in your OS keychain, never in settings files. Create it at `<app>.gadget.app/edit/settings/api-keys` and give it a role with read access, plus action permissions if you enable writes |
| Environment | `production` (default) or `development` |
| Allow writes / Allow deletes | Both off by default |
| Limit writes to models | Optional allowlist, e.g. `label,blogPost` |
| Hide personal data | `pii` by default; clear it to show everything |

## What it runs, sends and stores

The plugin runs a local MCP server with `node`, from the [`@stronger-ecommerce/gadget-mcp`](https://www.npmjs.com/package/@stronger-ecommerce/gadget-mcp) package. When you install the plugin, Claude Code installs that package and its dependencies into the plugin folder from the bundled `package-lock.json`. Every version is pinned and checked against its integrity hash, all downloads come from the public npm registry, and no install scripts run. Nothing is downloaded when the server starts. The server's source is in [this repository](https://github.com/Stronger-eCommerce/gadget-mcp).

**Network requests it makes:**
- **Your Gadget app** (`https://<app>.gadget.app/api/graphql`, or `<app>--development.gadget.app`): every tool call, authenticated with your API key. Writes happen only when you enable them.
- **npm registry** (`https://registry.npmjs.org`): at most once a day, to check whether a newer version exists. Only the package name is requested. Set `GADGET_MCP_NO_UPDATE_CHECK=1` to turn it off.
- **Gadget's `ggt` CLI**: only when the `read_logs` tool is used. It runs `npx ggt@latest logs`, which talks to Gadget with your own `ggt login`.

**Local files it writes:** an update-check cache in `~/.cache/gadget-mcp/`. It also writes exports in `~/gadget-mcp-exports/` (only when you ask for an export) and an audit log (only if you set `GADGET_AUDIT_LOG`).

**What it never does:** there's no telemetry or analytics, and nothing is sent to Stronger eCommerce or Anthropic. The `report_bug` tool only builds a GitHub issue link for you to review. It never posts anything itself, and it strips API keys from the link.

See the [privacy policy](https://github.com/Stronger-eCommerce/gadget-mcp/blob/main/PRIVACY.md) for details.

## Support

Report bugs at [github.com/Stronger-eCommerce/gadget-mcp/issues](https://github.com/Stronger-eCommerce/gadget-mcp/issues), or ask Claude to "report a bug with the Gadget MCP". Full documentation is in the [main README](https://github.com/Stronger-eCommerce/gadget-mcp#readme).

## License

MIT. See [LICENSE](./LICENSE).

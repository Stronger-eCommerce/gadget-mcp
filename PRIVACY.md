# Privacy Policy: Gadget MCP

_Last updated: October 13, 2026_

This policy covers the open-source **Gadget MCP** server (`@stronger-ecommerce/gadget-mcp` on npm) and the **Gadget MCP** Claude plugin, both published by Stronger eCommerce ("we"). The software runs on your own computer, or on a server you control in HTTP mode. We don't operate any service that it sends your data to.

## What data the software handles

The software acts on your behalf against **your own Gadget app**, using the app slug and API key you provide. It reads, and if you enable write tools, changes, the records your API key's role allows. That data goes from your Gadget app to the AI client you use (such as Claude) as tool results.

- **Your API key** is used only to authenticate requests to your Gadget app. When you install the Claude plugin, the key is stored in your operating system's secure credential store by Claude Code. The software never sends it anywhere else, and the bug-report link it builds strips keys out.
- **Personal data in your app** can be hidden from results with the `GADGET_REDACT_FIELDS` setting. The Claude plugin turns this on (`pii`) by default.

## Where data is sent

| Destination | When | What |
|---|---|---|
| Your Gadget app (`*.gadget.app`) | Every tool call | GraphQL requests authenticated with your API key |
| npm registry (`registry.npmjs.org`) | At most once a day, unless `GADGET_MCP_NO_UPDATE_CHECK` is set | A request for the latest version number of this package. No app data, keys or identifiers are included |
| Gadget, through the `ggt` CLI | Only when you use the `read_logs` tool | Requests made by Gadget's own CLI with your own `ggt login` |

The AI client you connect, such as Claude, receives tool results under its own privacy terms. For Claude, see [Anthropic's privacy policy](https://www.anthropic.com/legal/privacy).

## What we collect

**Nothing.** The software has no telemetry, analytics, crash reporting or phone-home behavior. We don't receive your data, your API keys, or information about how you use the software.

If you choose to open a GitHub issue (for example with the `report_bug` tool, which only builds a link for you to review), whatever you submit is public on GitHub and covered by [GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## Data stored on your computer

- `~/.cache/gadget-mcp/update-check.json` holds the latest version number and when it was checked.
- `~/gadget-mcp-exports/` (or `GADGET_EXPORT_DIR`) holds files you ask `export_records` to create.
- The file you set in `GADGET_AUDIT_LOG`, if any, records the writes the agent made.

You can delete these at any time.

## Changes

We'll update this file when the software's data handling changes. The history of this policy is in the repository's commit log.

## Contact

Questions: open an issue at [github.com/Stronger-eCommerce/gadget-mcp/issues](https://github.com/Stronger-eCommerce/gadget-mcp/issues) or contact [Stronger eCommerce](https://strongerecommerce.com).

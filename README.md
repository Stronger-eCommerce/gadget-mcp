# @stronger-ecommerce/gadget-mcp

Generic MCP server for any [Gadget](https://gadget.dev) app — read-only by default, with optional write and delete tools.
Query any model via GraphQL introspection — no generated client required.

Built by [Stronger eCommerce](https://strongerecommerce.com).

---

## Install as a Claude Code plugin

```
/plugin install gadget --marketplace Stronger-eCommerce/gadget-mcp
```

On older Claude Code versions, run `/plugin marketplace add Stronger-eCommerce/gadget-mcp` and then `/plugin install gadget@stronger-ecommerce`.

Claude Code asks for your app slug and API key when you enable the plugin. The key is stored in your OS keychain. It also asks whether to allow writes and deletes, which models writes may touch, and what to redact. The plugin includes a skill that teaches Claude a safe workflow for these tools. Use `/plugin` to change the settings later.

---

## Quick setup (recommended)

Run the interactive setup wizard from inside your Gadget project directory.
It auto-detects your app slug from `.gadget/sync.json` and writes your config automatically.

```bash
npx @stronger-ecommerce/gadget-mcp setup
```

The wizard will:
1. Detect your app slug from `.gadget/sync.json` (if present)
2. Prompt for your API key and environment
3. Output the ready-to-run `claude mcp add` command for Claude Code
4. Automatically write your `~/.cursor/mcp.json` for Cursor

---

## Manual setup

### 1. Get a production API key

Go to `https://<your-app>.gadget.app/edit/settings/api-keys` and create a key with read access.

### 2. Register in Claude Code

```bash
claude mcp add my-app-gadget \
  -e GADGET_APP=my-app \
  -e GADGET_API_KEY=your_key_here \
  -- npx @stronger-ecommerce/gadget-mcp@latest
```

Register multiple apps under different names:

```bash
claude mcp add app-one-gadget \
  -e GADGET_APP=my-first-app \
  -e GADGET_API_KEY=key1 \
  -- npx @stronger-ecommerce/gadget-mcp@latest

claude mcp add app-two-gadget \
  -e GADGET_APP=my-second-app \
  -e GADGET_API_KEY=key2 \
  -- npx @stronger-ecommerce/gadget-mcp@latest
```

### 3. Register in Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "app-one-gadget": {
      "command": "npx",
      "args": ["@stronger-ecommerce/gadget-mcp@latest"],
      "env": {
        "GADGET_APP": "my-first-app",
        "GADGET_API_KEY": "key1"
      }
    },
    "app-two-gadget": {
      "command": "npx",
      "args": ["@stronger-ecommerce/gadget-mcp@latest"],
      "env": {
        "GADGET_APP": "my-second-app",
        "GADGET_API_KEY": "key2"
      }
    }
  }
}
```

---

## Environment variables

| Variable             | Required | Default      | Description                          |
|----------------------|----------|--------------|--------------------------------------|
| `GADGET_APP`         | Yes      | —            | App slug, e.g. `my-app`              |
| `GADGET_API_KEY`     | Yes      | —            | Production API key                   |
| `GADGET_ENVIRONMENT` | No       | `production` | `production` or `development`        |
| `GADGET_ALLOW_WRITES`  | No     | off          | `true` enables `create_record`, `update_record`, `run_action` |
| `GADGET_ALLOW_DELETES` | No     | off          | `true` enables `delete_record` (and delete actions via `run_action`) |
| `GADGET_AUDIT_LOG`     | No     | —            | Path to a JSONL file; every executed write is appended to it |
| `GADGET_WRITE_MODELS`  | No     | all          | Comma-separated models (or global action names) writes are limited to, e.g. `label,blogPost` |
| `GADGET_EXPORT_DIR`    | No     | `~/gadget-mcp-exports` | Where `export_records` saves files |
| `GADGET_REDACT_FIELDS` | No     | off          | `pii`, or comma-separated field patterns to hide from results, e.g. `email,*phone*` |
| `GADGET_MCP_NO_UPDATE_CHECK` | No | —          | Set to disable the daily npm update check |

---

## Tools

| Tool               | Description                                                |
|--------------------|------------------------------------------------------------|
| `list_models`      | List all models available in the app                       |
| `introspect_model` | Show fields and types for a model                          |
| `query_records`    | Query any model with filters and field selection           |
| `get_record`       | Fetch a single record by ID                                |
| `count_records`    | Count records, optionally filtered                         |
| `introspect_filters` | Show filter fields for a model                           |
| `introspect_actions` | List actions (mutations) and their arguments             |
| `get_schema_overview` | All models and fields in one call                       |
| `run_graphql`      | Run a raw read-only GraphQL query (mutations are blocked)  |
| `export_records`   | Export many records (up to 100k) to a CSV or JSON file     |
| `group_count`      | Count records grouped by a field, e.g. orders by status    |
| `read_logs`        | Read recent app logs (via `ggt`), filtered by level, time and text |
| `report_bug`       | Build a pre-filled GitHub bug report link (nothing is posted) |

### Optional write tools

Off by default. Tools are only listed to the client when their flag is set, and the server refuses them otherwise.

| Tool            | Flag                   | Description                                                    |
|-----------------|------------------------|----------------------------------------------------------------|
| `create_record` | `GADGET_ALLOW_WRITES`  | Run a model's `create` action                                  |
| `update_record` | `GADGET_ALLOW_WRITES`  | Run a model's `update` action                                  |
| `run_action`    | `GADGET_ALLOW_WRITES`  | Run any model or global action by name (e.g. `publishBlogPost`) |
| `bulk_update`   | `GADGET_ALLOW_WRITES`  | Update every record matching a filter (dry run first, capped at `max_records`) |
| `delete_record` | `GADGET_ALLOW_DELETES` | Run a model's `delete` action                                  |

Every write tool takes `dry_run: true`, which checks the action and arguments against the schema and returns the exact mutation and variables without changing anything — handy for asking the agent to "show me what you'd do first".

Set `GADGET_WRITE_MODELS=label,blogPost` to limit changes to those models; every other model is refused, even with writes on. Global actions are matched by name, e.g. `GADGET_WRITE_MODELS=label,syncProducts`. The tool descriptions tell the agent which models are allowed.

Set `GADGET_AUDIT_LOG=~/gadget-mcp-audit.jsonl` to keep a local record of every write (timestamp, app, environment, action, variables, success/errors).

Writes go through your Gadget actions, so validations and action code run as normal. The API key's role also needs the matching action permissions — the `setup` wizard asks whether to enable writes/deletes and can create a `gadget-mcp-write` role with them.

```bash
claude mcp add my-app-gadget \
  -e GADGET_APP=my-app \
  -e GADGET_API_KEY=your_key_here \
  -e GADGET_ALLOW_WRITES=true \
  -e GADGET_ALLOW_DELETES=true \
  -- npx @stronger-ecommerce/gadget-mcp@latest
```

---

## Field selection

`query_records` and `get_record` return every scalar field when `fields` is left out. Use `*` to mix all scalars with relations:

```
fields: "* customer { email } lineItems { edges { node { title quantity } } }"
```

---

## Working with lots of records

- **`export_records`** pages through a model and saves a CSV or JSON file in `GADGET_EXPORT_DIR` (default `~/gadget-mcp-exports`). Nested fields become dot-named columns, e.g. `customer.email`. It returns the path, row count and a preview, and stops at `max_records` (default 10,000, max 100,000).
- **`group_count`** answers questions like "orders by financial status" in one call. Enum and boolean fields get exact counts per value. Other fields are counted by scanning up to `max_records`, and the result says whether it was exact.
- **`bulk_update`** (writes on) applies the same change to every record matching a filter, running the model's `update` action on each. Use `dry_run: true` to see how many records match. It refuses when more than `max_records` match (default 100, max 1,000), and `GADGET_WRITE_MODELS` is checked before anything changes.

---

## Logs

`read_logs` fetches recent logs through Gadget's [`ggt` CLI](https://docs.gadget.dev/reference/ggt#ggt-logs). It defaults to the last 15 minutes at `info` level, and you can filter by `since` (`2h`, `1d` or an ISO time), `level`, `search` text, and `my_logs` to show only your own code's logs. `ggt` uses its own login, so run `npx ggt login` once on the machine. Set `GADGET_GGT_COMMAND=ggt` to use a globally installed `ggt` instead of `npx ggt@latest`. Redaction applies to log output too.

---

## Prompts

The server ships ready-made prompts that appear in your client's prompt picker (slash commands in Claude Code):

| Prompt | What it does |
|---|---|
| `explore_app` | Plain-English overview of the models, how they relate and how much data each holds |
| `debug_record` | Investigates one record: fields, related logs and a likely cause |
| `audit_errors` | Groups recent errors from the logs, with counts and likely causes |
| `data_health` | Checks a model for missing values and odd statuses |

---

## Remote / HTTP mode

Run the server over HTTP so clients can connect by URL instead of launching it locally:

```bash
GADGET_APP=my-app GADGET_API_KEY=... GADGET_MCP_HTTP_TOKEN=$(openssl rand -hex 24) \
  npx @stronger-ecommerce/gadget-mcp@latest serve
```

| Variable | Default | |
|---|---|---|
| `GADGET_MCP_HTTP_PORT` | `3333` | Port |
| `GADGET_MCP_HTTP_HOST` | `127.0.0.1` | Interface to bind. Anything but localhost **requires** a token |
| `GADGET_MCP_HTTP_TOKEN` | — | Shared secret: send `Authorization: Bearer <token>`, or use the secret URL `/mcp/<token>` for clients that can't set headers |

The endpoint is `/mcp`, and `/health` answers without auth. Connect from Claude Code with `claude mcp add --transport http my-app-gadget https://host/mcp --header "Authorization: Bearer <token>"`. Put it behind HTTPS (a reverse proxy or tunnel) before exposing it beyond your machine. Anyone with the token can use your Gadget API key with whatever write settings you've enabled.

---

## Hiding personal data

Set `GADGET_REDACT_FIELDS=pii` to replace customer emails, phones, names, addresses, coordinates and IPs with `[REDACTED]` in every result. That includes nested objects and `run_graphql`. You can also list your own patterns, where `*` is a wildcard: `GADGET_REDACT_FIELDS=email,*phone*,taxId`.

You can still *filter* by a redacted field ("find the order for jane@example.com"). The value just never comes back to the agent. While redaction is on, field aliases (`e: email`) are refused so they can't be used to rename a field around it. Treat it as a strong guardrail rather than a security boundary: the API key itself can still read everything.

---

## Rate limits

When Gadget throttles a request (HTTP 429) or is briefly unavailable (502/503/504), the server retries up to 3 times. It honours `Retry-After` when present and otherwise uses exponential backoff.

---

## Staying up to date

The server checks npm at most once a day. When a new version is out it prints an update box in your terminal and adds a one-time note to the agent's next tool result, so the agent can let you know too. To upgrade:

```bash
npx @stronger-ecommerce/gadget-mcp@latest upgrade
```

`upgrade` shows what changed, updates a global npm install if you have one, and switches editor configs from a cached `npx @stronger-ecommerce/gadget-mcp` to `@latest` so they always start the newest version. New installs from `setup` use `@latest` already.

---

## Example usage

Once connected, ask Claude:
- *"List the models in my Gadget app"*
- *"Show me the fields on the shopifyOrder model"*
- *"Find orders where email is customer@example.com"*
- *"Get all records with errors"*

---

## Future features

Planned ideas and research notes (including logs / `ggt` integration for agents) live in [FUTURE_FEATURES.md](./FUTURE_FEATURES.md).

---

## Reporting bugs

The quickest way is:

```bash
npx @stronger-ecommerce/gadget-mcp@latest bug
```

It asks for a title and a short description, then opens a [bug report](https://github.com/Stronger-eCommerce/gadget-mcp/issues/new?template=bug_report.yml) with your version, Node, OS, environment and enabled flags already filled in. You can also ask your agent to *"report a bug with the Gadget MCP"*: the `report_bug` tool hands you the same pre-filled link. API keys and your app slug are never included, and nothing is posted until you submit the issue yourself.

---

## Contributing

Bug reports and pull requests are welcome!

- **Found a bug?** [Open an issue](https://github.com/Stronger-eCommerce/gadget-mcp/issues)
- **Have a fix or feature?** Fork the repo, make your changes, and open a PR against `main`
- For significant changes, open an issue first so we can align on the approach

### Running locally

```bash
git clone https://github.com/Stronger-eCommerce/gadget-mcp
cd gadget-mcp
npm install
npm run build
npm test
```

### Releasing (maintainers)

Go to **Actions → Release → Run workflow**, pick `patch`, `minor` or `major`, and run it. This works from the GitHub mobile app too. The workflow tests, bumps the version, tags, publishes to npm with provenance, and creates the GitHub Release with generated notes. Pick `none` to publish the version already in `package.json`.

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers), so there's no npm token to rotate. On npmjs.com the package's trusted publisher is GitHub Actions, `Stronger-eCommerce/gadget-mcp`, workflow `release.yml`.

---

## About

Made with ♥ by [Stronger eCommerce](https://strongerecommerce.com) — Shopify development and eCommerce operations.

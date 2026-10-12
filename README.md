# @stronger-ecommerce/gadget-mcp

Generic MCP server for any [Gadget](https://gadget.dev) app — read-only by default, with optional write and delete tools.
Query any model via GraphQL introspection — no generated client required.

Built by [Stronger eCommerce](https://strongerecommerce.com).

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
| `report_bug`       | Build a pre-filled GitHub bug report link (nothing is posted) |

### Optional write tools

Off by default. Tools are only listed to the client when their flag is set, and the server refuses them otherwise.

| Tool            | Flag                   | Description                                                    |
|-----------------|------------------------|----------------------------------------------------------------|
| `create_record` | `GADGET_ALLOW_WRITES`  | Run a model's `create` action                                  |
| `update_record` | `GADGET_ALLOW_WRITES`  | Run a model's `update` action                                  |
| `run_action`    | `GADGET_ALLOW_WRITES`  | Run any model or global action by name (e.g. `publishBlogPost`) |
| `delete_record` | `GADGET_ALLOW_DELETES` | Run a model's `delete` action                                  |

Every write tool takes `dry_run: true`, which checks the action and arguments against the schema and returns the exact mutation and variables without changing anything — handy for asking the agent to "show me what you'd do first".

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

---

## About

Made with ♥ by [Stronger eCommerce](https://strongerecommerce.com) — Shopify development and eCommerce operations.

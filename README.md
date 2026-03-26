# @stronger-ecommerce/gadget-mcp

Generic read-only MCP server for any [Gadget](https://gadget.dev) app.
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
  -- npx @stronger-ecommerce/gadget-mcp
```

Register multiple apps under different names:

```bash
claude mcp add app-one-gadget \
  -e GADGET_APP=my-first-app \
  -e GADGET_API_KEY=key1 \
  -- npx @stronger-ecommerce/gadget-mcp

claude mcp add app-two-gadget \
  -e GADGET_APP=my-second-app \
  -e GADGET_API_KEY=key2 \
  -- npx @stronger-ecommerce/gadget-mcp
```

### 3. Register in Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "app-one-gadget": {
      "command": "npx",
      "args": ["@stronger-ecommerce/gadget-mcp"],
      "env": {
        "GADGET_APP": "my-first-app",
        "GADGET_API_KEY": "key1"
      }
    },
    "app-two-gadget": {
      "command": "npx",
      "args": ["@stronger-ecommerce/gadget-mcp"],
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

---

## Tools

| Tool               | Description                                                |
|--------------------|------------------------------------------------------------|
| `list_models`      | List all models available in the app                       |
| `introspect_model` | Show fields and types for a model                          |
| `query_records`    | Query any model with filters and field selection           |
| `get_record`       | Fetch a single record by ID                                |
| `run_graphql`      | Run a raw read-only GraphQL query (mutations are blocked)  |

---

## Example usage

Once connected, ask Claude:
- *"List the models in my Gadget app"*
- *"Show me the fields on the shopifyOrder model"*
- *"Find orders where email is customer@example.com"*
- *"Get all records with errors"*

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

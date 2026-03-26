# @stronger-ecommerce/gadget-mcp

Generic read-only MCP server for any [Gadget](https://gadget.dev) app.
Query any model via GraphQL introspection — no generated client required.

## Setup

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
claude mcp add brightpearl-gadget \
  -e GADGET_APP=brightpearl \
  -e GADGET_API_KEY=key1 \
  -- npx @stronger-ecommerce/gadget-mcp

claude mcp add store-gadget \
  -e GADGET_APP=my-store \
  -e GADGET_API_KEY=key2 \
  -- npx @stronger-ecommerce/gadget-mcp
```

### 3. Register in Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "brightpearl-gadget": {
      "command": "npx",
      "args": ["gadget-mcp"],
      "env": {
        "GADGET_APP": "brightpearl",
        "GADGET_API_KEY": "key1"
      }
    },
    "store-gadget": {
      "command": "npx",
      "args": ["gadget-mcp"],
      "env": {
        "GADGET_APP": "my-store",
        "GADGET_API_KEY": "key2"
      }
    }
  }
}
```

## Environment variables

| Variable            | Required | Default        | Description                          |
|---------------------|----------|----------------|--------------------------------------|
| `GADGET_APP`        | Yes      | —              | App slug, e.g. `brightpearl`         |
| `GADGET_API_KEY`    | Yes      | —              | Production API key                   |
| `GADGET_ENVIRONMENT`| No       | `production`   | `production` or `development`        |

## Tools

| Tool               | Description                                                   |
|--------------------|---------------------------------------------------------------|
| `list_models`      | List all models available in the app                         |
| `introspect_model` | Show fields and types for a model                            |
| `query_records`    | Query any model with filters and field selection             |
| `get_record`       | Fetch a single record by ID                                  |
| `run_graphql`      | Run a raw read-only GraphQL query (mutations are blocked)    |

## Example usage

Once connected, ask Claude:
- *"List the models in my Gadget app"*
- *"Show me the fields on the shopifyOrder model"*
- *"Find orders where brightpearlSoId is 12345"*
- *"Get all labels with errors"*

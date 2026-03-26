/**
 * Generic Gadget MCP Server
 * Works with any Gadget app — no generated client required.
 *
 * ── CONFIG ──────────────────────────────────────────────────────────────────
 * Required env vars:
 *   GADGET_APP         App slug, e.g. "brightpearl" or "my-other-app"
 *   GADGET_API_KEY     Production API key from <app>.gadget.app/edit/settings/api-keys
 *
 * Optional:
 *   GADGET_ENVIRONMENT "production" (default) | "development"
 *
 * ── REGISTER IN CLAUDE CODE ─────────────────────────────────────────────────
 *   claude mcp add brightpearl-gadget \
 *     -e GADGET_APP=brightpearl \
 *     -e GADGET_API_KEY=your_key \
 *     -- npx tsx /Users/jayfriedmann/brightpearl/mcp/index.ts
 *
 *   # For a second app:
 *   claude mcp add myapp-gadget \
 *     -e GADGET_APP=my-other-app \
 *     -e GADGET_API_KEY=other_key \
 *     -- npx tsx /Users/jayfriedmann/brightpearl/mcp/index.ts
 *
 * ── REGISTER IN CURSOR (~/.cursor/mcp.json) ─────────────────────────────────
 *   {
 *     "mcpServers": {
 *       "brightpearl-gadget": {
 *         "command": "npx",
 *         "args": ["tsx", "/Users/jayfriedmann/brightpearl/mcp/index.ts"],
 *         "env": { "GADGET_APP": "brightpearl", "GADGET_API_KEY": "your_key" }
 *       },
 *       "myapp-gadget": {
 *         "command": "npx",
 *         "args": ["tsx", "/Users/jayfriedmann/brightpearl/mcp/index.ts"],
 *         "env": { "GADGET_APP": "my-other-app", "GADGET_API_KEY": "other_key" }
 *       }
 *     }
 *   }
 * ────────────────────────────────────────────────────────────────────────────
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ──────────────────────────────────────────────────────────────────
const GADGET_APP = process.env.GADGET_APP;
const GADGET_API_KEY = process.env.GADGET_API_KEY;
const GADGET_ENVIRONMENT = process.env.GADGET_ENVIRONMENT ?? "production";

if (!GADGET_APP || !GADGET_API_KEY) {
  console.error("GADGET_APP and GADGET_API_KEY environment variables are required");
  process.exit(1);
}

const GRAPHQL_URL =
  GADGET_ENVIRONMENT === "development"
    ? `https://${GADGET_APP}--development.gadget.app/api/graphql`
    : `https://${GADGET_APP}.gadget.app/api/graphql`;

// ── GraphQL helper ───────────────────────────────────────────────────────────
async function gql(query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GADGET_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  }

  const json = await res.json() as any;
  if (json.errors?.length) {
    throw new Error(json.errors.map((e: any) => e.message).join("; "));
  }
  return json.data;
}

// ── MCP Server ───────────────────────────────────────────────────────────────
const server = new Server(
  { name: `${GADGET_APP}-gadget`, version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "introspect_model",
      description:
        "List all fields and their types for a Gadget model. Run this first when you're unsure what fields exist on a model.",
      inputSchema: {
        type: "object",
        required: ["model"],
        properties: {
          model: {
            type: "string",
            description: "Model name in camelCase, e.g. shopifyOrder, label, shopifyShop",
          },
        },
      },
    },
    {
      name: "list_models",
      description: "List all models (types) available in this Gadget app via GraphQL introspection.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "query_records",
      description:
        "Query records from any Gadget model. Specify the model name and a GraphQL field selection. Use introspect_model first to discover available fields.",
      inputSchema: {
        type: "object",
        required: ["model", "fields"],
        properties: {
          model: {
            type: "string",
            description: "Model name in camelCase, e.g. shopifyOrder, label",
          },
          fields: {
            type: "string",
            description:
              "GraphQL field selection, e.g. \"id name brightpearlSoId email createdAt\" or \"id trackingNumber error errorMessage\"",
          },
          filter: {
            type: "object",
            description:
              "Gadget filter object, e.g. { \"name\": { \"equals\": \"#59389\" } } or { \"error\": { \"equals\": true } }",
          },
          limit: {
            type: "number",
            description: "Max records to return (default 10, max 50)",
          },
        },
      },
    },
    {
      name: "get_record",
      description:
        "Get a single Gadget record by ID. Specify the model name, record ID, and fields to return.",
      inputSchema: {
        type: "object",
        required: ["model", "id", "fields"],
        properties: {
          model: {
            type: "string",
            description: "Model name in camelCase, e.g. shopifyOrder, label",
          },
          id: {
            type: "string",
            description: "Record ID",
          },
          fields: {
            type: "string",
            description: "GraphQL field selection, e.g. \"id name email brightpearlSoId\"",
          },
        },
      },
    },
    {
      name: "run_graphql",
      description:
        "Run an arbitrary read-only GraphQL query against the Gadget app. Use this for complex queries with nested relations or custom filtering that query_records can't express.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "GraphQL query string",
          },
          variables: {
            type: "object",
            description: "GraphQL variables",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_models": {
        const data = await gql(`
          query {
            __schema {
              queryType {
                fields {
                  name
                  description
                  type { name kind }
                }
              }
            }
          }
        `);
        // Filter to Gadget model queries (findMany / findOne patterns)
        const fields: any[] = data.__schema.queryType.fields;
        const models = fields
          .filter((f) => f.name && !f.name.startsWith("__") && f.type?.kind === "OBJECT")
          .map((f) => ({ name: f.name, description: f.description ?? "" }));
        return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
      }

      case "introspect_model": {
        const { model } = args as { model: string };
        // Gadget exposes a connection type for findMany — introspect the node type
        const typeName = model.charAt(0).toUpperCase() + model.slice(1);
        const data = await gql(`
          query IntrospectModel($name: String!) {
            __type(name: $name) {
              name
              fields {
                name
                description
                type {
                  name
                  kind
                  ofType { name kind }
                }
              }
            }
          }
        `, { name: typeName });
        if (!data.__type) {
          return {
            content: [{ type: "text", text: `No type found for "${typeName}". Try list_models to see available model names, then adjust casing.` }],
          };
        }
        return { content: [{ type: "text", text: JSON.stringify(data.__type, null, 2) }] };
      }

      case "query_records": {
        const { model, fields, filter, limit = 10 } = args as {
          model: string;
          fields: string;
          filter?: Record<string, unknown>;
          limit?: number;
        };
        const first = Math.min(limit, 50);
        const filterArg = filter ? `, filter: $filter` : "";
        const varsDef = filter ? `($filter: ${model.charAt(0).toUpperCase() + model.slice(1)}Filter, $first: Int)` : `($first: Int)`;
        const varsVal: Record<string, unknown> = { first };
        if (filter) varsVal.filter = filter;

        const query = `
          query QueryRecords${varsDef} {
            ${model}(first: $first${filterArg}) {
              edges {
                node {
                  ${fields}
                }
              }
              pageInfo { hasNextPage }
            }
          }
        `;

        const data = await gql(query, varsVal);
        const connection = data[model];
        const records = connection.edges.map((e: any) => e.node);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ records, hasMore: connection.pageInfo.hasNextPage }, null, 2),
          }],
        };
      }

      case "get_record": {
        const { model, id, fields } = args as { model: string; id: string; fields: string };
        const query = `
          query GetRecord($id: GadgetID!) {
            ${model}(id: $id) {
              ${fields}
            }
          }
        `;
        const data = await gql(query, { id });
        return { content: [{ type: "text", text: JSON.stringify(data[model], null, 2) }] };
      }

      case "run_graphql": {
        const { query, variables } = args as { query: string; variables?: Record<string, unknown> };
        // Reject mutations
        const trimmed = query.trim().toLowerCase();
        if (trimmed.startsWith("mutation")) {
          return {
            content: [{ type: "text", text: "Mutations are not allowed — this server is read-only." }],
            isError: true,
          };
        }
        const data = await gql(query, variables);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Error: ${err?.message ?? String(err)}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

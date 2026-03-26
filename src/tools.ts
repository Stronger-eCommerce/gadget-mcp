// ── Config ────────────────────────────────────────────────────────────────────
const GADGET_APP = process.env.GADGET_APP;
const GADGET_API_KEY = process.env.GADGET_API_KEY;
const GADGET_ENVIRONMENT = process.env.GADGET_ENVIRONMENT ?? "production";

export const GRAPHQL_URL =
  GADGET_ENVIRONMENT === "development"
    ? `https://${GADGET_APP}--development.gadget.app/api/graphql`
    : `https://${GADGET_APP}.gadget.app/api/graphql`;

// ── GraphQL helper ────────────────────────────────────────────────────────────
export async function gql(query: string, variables?: Record<string, unknown>): Promise<any> {
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
    const permissionError = json.errors.find((e: any) => e.extensions?.code === "GGT_PERMISSION_DENIED");
    if (permissionError) {
      throw new Error(
        `Permission denied (GGT_PERMISSION_DENIED): your API key has no role assigned, or the role lacks read access to this model.\n` +
        `Fix: go to ${GADGET_APP}.gadget.app/edit/${GADGET_ENVIRONMENT}/settings/api-keys and assign a role with read permissions to your key.`
      );
    }
    throw new Error(json.errors.map((e: any) => e.message).join("; "));
  }
  return json.data;
}

// ── Query field resolver (introspection cache) ────────────────────────────────
interface ResolvedListField {
  fieldName: string;       // e.g. "labels", "shopifyOrders"
  filterArgType?: string;  // full type string, e.g. "[LabelFilter!]"
}

let queryFieldsCache: any[] | null = null;
const listFieldCache = new Map<string, ResolvedListField | null>();

/** Reset introspection caches — exposed for unit tests only */
export function _resetCaches() {
  queryFieldsCache = null;
  listFieldCache.clear();
}

// Reconstruct a type string from a GraphQL __type fragment (handles NON_NULL / LIST nesting)
function typeString(t: any): string {
  if (!t) return "String";
  if (t.kind === "NON_NULL") return `${typeString(t.ofType)}!`;
  if (t.kind === "LIST")     return `[${typeString(t.ofType)}]`;
  return t.name ?? "String";
}

async function resolveListField(model: string): Promise<ResolvedListField | null> {
  const cached = listFieldCache.get(model);
  if (cached !== undefined) return cached;

  if (!queryFieldsCache) {
    const data = await gql(`
      query {
        __schema {
          queryType {
            fields {
              name
              args {
                name
                type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
              }
              type {
                kind name
                ofType { kind name ofType { kind name } }
              }
            }
          }
        }
      }
    `);
    queryFieldsCache = data.__schema.queryType.fields;
  }

  const modelType = model.charAt(0).toUpperCase() + model.slice(1);

  // Find the query field whose return type is <ModelType>Connection
  const field = queryFieldsCache!.find((f: any) => {
    let t = f.type;
    // Unwrap NON_NULL
    if (t?.kind === "NON_NULL") t = t.ofType;
    return t?.name === `${modelType}Connection`;
  });

  if (!field) {
    listFieldCache.set(model, null);
    return null;
  }

  // Find the filter argument and reconstruct its full type string
  const filterArg = field.args?.find((a: any) => a.name === "filter");
  const filterArgType = filterArg ? typeString(filterArg.type) : undefined;

  const result: ResolvedListField = { fieldName: field.name, filterArgType };
  listFieldCache.set(model, result);
  return result;
}

// ── Tool handler ──────────────────────────────────────────────────────────────
export async function handleTool(name: string, args: Record<string, any>): Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}> {
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
        const fields: any[] = data.__schema.queryType.fields;
        const models = fields
          .filter((f) => f.name && !f.name.startsWith("__") && f.type?.kind === "OBJECT")
          .map((f) => ({ name: f.name, description: f.description ?? "" }));
        return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
      }

      case "introspect_model": {
        const { model } = args as { model: string };
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
          filter?: unknown;
          limit?: number;
        };
        const first = Math.min(limit, 50);

        // Resolve the real connection field name and filter type via introspection
        const resolved = await resolveListField(model);
        if (!resolved) {
          return {
            content: [{ type: "text", text: `No connection field found for model "${model}". Use list_models to browse available models.` }],
            isError: true,
          };
        }

        const { fieldName, filterArgType } = resolved;
        const filterClause = filter ? `, filter: $filter` : "";
        const varsDef = filter && filterArgType
          ? `($first: Int, $filter: ${filterArgType})`
          : `($first: Int)`;
        const varsVal: Record<string, unknown> = { first };
        if (filter) varsVal.filter = filter;

        const query = `
          query QueryRecords${varsDef} {
            ${fieldName}(first: $first${filterClause}) {
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
        const connection = data[fieldName];
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
}

// ── Tool definitions (for MCP ListTools) ──────────────────────────────────────
export const TOOL_DEFINITIONS = [
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
      "Query records from any Gadget model. Specify the model name (singular camelCase) and a GraphQL field selection. Use introspect_model first to discover available fields.",
    inputSchema: {
      type: "object",
      required: ["model", "fields"],
      properties: {
        model: { type: "string", description: "Model name in singular camelCase, e.g. shopifyOrder, label" },
        fields: {
          type: "string",
          description: "GraphQL field selection, e.g. \"id name email createdAt\"",
        },
        filter: {
          description: "Filter value — shape depends on the model's schema (object or array of filter objects). Use run_graphql for complex filters.",
        },
        limit: { type: "number", description: "Max records to return (default 10, max 50)" },
      },
    },
  },
  {
    name: "get_record",
    description: "Get a single Gadget record by ID. Specify the model name, record ID, and fields to return.",
    inputSchema: {
      type: "object",
      required: ["model", "id", "fields"],
      properties: {
        model: { type: "string", description: "Model name in camelCase, e.g. shopifyOrder, label" },
        id: { type: "string", description: "Record ID" },
        fields: { type: "string", description: "GraphQL field selection, e.g. \"id name email createdAt\"" },
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
        query: { type: "string", description: "GraphQL query string" },
        variables: { type: "object", description: "GraphQL variables" },
      },
    },
  },
];

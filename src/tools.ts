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
  sortArgType?: string;    // full type string, e.g. "[LabelSort!]"
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

  const filterArg = field.args?.find((a: any) => a.name === "filter");
  const filterArgType = filterArg ? typeString(filterArg.type) : undefined;

  const sortArg = field.args?.find((a: any) => a.name === "sort");
  const sortArgType = sortArg ? typeString(sortArg.type) : undefined;

  const result: ResolvedListField = { fieldName: field.name, filterArgType, sortArgType };
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
        const { model, fields, filter, sort, limit = 10, after } = args as {
          model: string;
          fields: string;
          filter?: unknown;
          sort?: unknown;
          limit?: number;
          after?: string;
        };
        const first = Math.min(limit, 50);

        const resolved = await resolveListField(model);
        if (!resolved) {
          return {
            content: [{ type: "text", text: `No connection field found for model "${model}". Use list_models to browse available models.` }],
            isError: true,
          };
        }

        const { fieldName, filterArgType, sortArgType } = resolved;
        const varParts: string[] = ["$first: Int"];
        const argParts: string[] = ["first: $first"];
        const varsVal: Record<string, unknown> = { first };

        if (after) {
          varParts.push("$after: String");
          argParts.push("after: $after");
          varsVal.after = after;
        }

        if (filter !== undefined && filterArgType) {
          varParts.push(`$filter: ${filterArgType}`);
          argParts.push("filter: $filter");
          varsVal.filter = filter;
        }

        if (sort !== undefined && sortArgType) {
          varParts.push(`$sort: ${sortArgType}`);
          argParts.push("sort: $sort");
          varsVal.sort = sort;
        }

        const query = `
          query QueryRecords(${varParts.join(", ")}) {
            ${fieldName}(${argParts.join(", ")}) {
              edges {
                node {
                  ${fields}
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        `;

        const data = await gql(query, varsVal);
        const connection = data[fieldName];
        const records = connection.edges.map((e: any) => e.node);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              records,
              hasMore: connection.pageInfo.hasNextPage,
              endCursor: connection.pageInfo.endCursor ?? null,
            }, null, 2),
          }],
        };
      }

      case "count_records": {
        const { model, filter } = args as { model: string; filter?: unknown };

        const resolved = await resolveListField(model);
        if (!resolved) {
          return {
            content: [{ type: "text", text: `No connection field found for model "${model}". Use list_models to browse available models.` }],
            isError: true,
          };
        }

        const { fieldName, filterArgType } = resolved;
        const varParts: string[] = [];
        const argParts: string[] = [];
        const varsVal: Record<string, unknown> = {};

        if (filter !== undefined && filterArgType) {
          varParts.push(`$filter: ${filterArgType}`);
          argParts.push("filter: $filter");
          varsVal.filter = filter;
        }

        const varsDef = varParts.length ? `(${varParts.join(", ")})` : "";
        const argsClause = argParts.length ? `(${argParts.join(", ")})` : "";

        const query = `
          query CountRecords${varsDef} {
            ${fieldName}${argsClause} {
              count
            }
          }
        `;

        const data = await gql(query, Object.keys(varsVal).length ? varsVal : undefined);
        const count = data[fieldName].count;
        return {
          content: [{ type: "text", text: JSON.stringify({ model, count }, null, 2) }],
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

      case "introspect_filters": {
        const { model } = args as { model: string };

        const resolved = await resolveListField(model);
        if (!resolved?.filterArgType) {
          return {
            content: [{ type: "text", text: `No filter type found for model "${model}". Use list_models to verify the model name.` }],
            isError: true,
          };
        }

        // Extract base type name from e.g. "[ShopifyOrderFilter!]" → "ShopifyOrderFilter"
        const filterTypeName = resolved.filterArgType.replace(/[\[\]!]/g, "");

        const data = await gql(`
          query IntrospectFilters($name: String!) {
            __type(name: $name) {
              name
              inputFields {
                name
                description
                type {
                  name kind
                  ofType { name kind ofType { name kind } }
                }
              }
            }
          }
        `, { name: filterTypeName });

        if (!data.__type) {
          return {
            content: [{ type: "text", text: `Filter type "${filterTypeName}" not found in schema.` }],
            isError: true,
          };
        }

        return { content: [{ type: "text", text: JSON.stringify(data.__type, null, 2) }] };
      }

      case "introspect_actions": {
        const data = await gql(`
          query {
            __schema {
              mutationType {
                fields {
                  name
                  description
                  args {
                    name
                    description
                    type {
                      name kind
                      ofType { name kind ofType { name kind } }
                    }
                  }
                }
              }
            }
          }
        `);

        if (!data.__schema.mutationType) {
          return { content: [{ type: "text", text: "No actions (mutations) found in this schema." }] };
        }

        const actions = (data.__schema.mutationType.fields as any[]).map((f) => ({
          name: f.name,
          description: f.description ?? "",
          args: (f.args ?? []).map((a: any) => ({
            name: a.name,
            type: typeString(a.type),
            description: a.description ?? "",
          })),
        }));

        return { content: [{ type: "text", text: JSON.stringify(actions, null, 2) }] };
      }

      case "get_schema_overview": {
        const data = await gql(`
          query {
            __schema {
              queryType {
                fields {
                  name
                  type {
                    kind name
                    ofType { kind name }
                  }
                }
              }
              types {
                name
                kind
                description
                fields {
                  name
                  description
                  type {
                    name kind
                    ofType { name kind ofType { name kind } }
                  }
                }
              }
            }
          }
        `);

        // Identify model names from Connection return types in query fields
        const modelNames = new Set<string>();
        for (const f of data.__schema.queryType.fields as any[]) {
          let t = f.type;
          if (t?.kind === "NON_NULL") t = t.ofType;
          if (t?.name?.endsWith("Connection")) {
            modelNames.add(t.name.replace(/Connection$/, ""));
          }
        }

        const models = (data.__schema.types as any[])
          .filter((t) => modelNames.has(t.name) && t.kind === "OBJECT")
          .map((t) => ({
            name: t.name,
            description: t.description ?? "",
            fields: (t.fields ?? []).map((f: any) => ({
              name: f.name,
              type: typeString(f.type),
              description: f.description ?? "",
            })),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        return { content: [{ type: "text", text: JSON.stringify(models, null, 2) }] };
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
      "Query records from any Gadget model. Supports filtering, sorting, pagination cursors, and field selection. Use introspect_model first to discover available fields, and introspect_filters to see valid filter shapes.",
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
          description: "Filter value — use introspect_filters to discover valid filter fields and shapes.",
        },
        sort: {
          description: "Sort value — array of sort objects, e.g. [{ createdAt: { sortOrder: \"Descending\" } }]",
        },
        limit: { type: "number", description: "Max records to return (default 10, max 50)" },
        after: { type: "string", description: "Pagination cursor — pass the endCursor from a previous response to fetch the next page" },
      },
    },
  },
  {
    name: "count_records",
    description: "Return the total number of records for a Gadget model, with optional filtering.",
    inputSchema: {
      type: "object",
      required: ["model"],
      properties: {
        model: { type: "string", description: "Model name in singular camelCase, e.g. shopifyOrder, label" },
        filter: {
          description: "Optional filter to count only matching records. Use introspect_filters to discover valid filter shapes.",
        },
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
    name: "introspect_filters",
    description:
      "Show all available filter fields and their types for a Gadget model. Use this to construct valid filter arguments for query_records and count_records.",
    inputSchema: {
      type: "object",
      required: ["model"],
      properties: {
        model: { type: "string", description: "Model name in singular camelCase, e.g. shopifyOrder, label" },
      },
    },
  },
  {
    name: "introspect_actions",
    description:
      "List all actions (mutations) available in this Gadget app, including their arguments. Useful for understanding what write operations are available, even though this server is read-only.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_schema_overview",
    description:
      "Return all models with their fields and types in a single call. Use this for a broad understanding of the app schema before diving into specific models.",
    inputSchema: { type: "object", properties: {} },
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

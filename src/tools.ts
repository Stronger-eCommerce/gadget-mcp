import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

// ── Config ────────────────────────────────────────────────────────────────────
const GADGET_APP = process.env.GADGET_APP;
const GADGET_API_KEY = process.env.GADGET_API_KEY;
const GADGET_ENVIRONMENT = process.env.GADGET_ENVIRONMENT ?? "production";

// Write access is opt-in. Read at call time so the server (and tests) can toggle it via env.
function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes((process.env[name] ?? "").trim().toLowerCase());
}
export const writesEnabled = () => envFlag("GADGET_ALLOW_WRITES");
export const deletesEnabled = () => envFlag("GADGET_ALLOW_DELETES");

const WRITES_DISABLED_MSG =
  "Write tools are disabled. Set GADGET_ALLOW_WRITES=true in this MCP server's env to enable create/update/run_action.";
const DELETES_DISABLED_MSG =
  "Delete is disabled. Set GADGET_ALLOW_DELETES=true in this MCP server's env to enable deleting records.";

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
let mutationFieldsCache: any[] | null = null;

/** Reset introspection caches — exposed for unit tests only */
export function _resetCaches() {
  queryFieldsCache = null;
  listFieldCache.clear();
  mutationFieldsCache = null;
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

// ── Mutation resolver (introspection cache) ───────────────────────────────────
interface ResolvedMutation {
  name: string;
  args: { name: string; type: string }[];
}

async function resolveMutation(name: string): Promise<ResolvedMutation | null> {
  if (!mutationFieldsCache) {
    const data = await gql(`
      query {
        __schema {
          mutationType {
            fields {
              name
              args {
                name
                type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
              }
            }
          }
        }
      }
    `);
    mutationFieldsCache = data.__schema.mutationType?.fields ?? [];
  }
  const field = mutationFieldsCache!.find((f: any) => f.name === name);
  if (!field) return null;
  return {
    name: field.name,
    args: (field.args ?? []).map((a: any) => ({ name: a.name, type: typeString(a.type) })),
  };
}

/** Append one JSON line per executed write to GADGET_AUDIT_LOG, if set. Never fails the write. */
function auditLog(entry: Record<string, unknown>): void {
  const file = process.env.GADGET_AUDIT_LOG;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(
      file,
      JSON.stringify({ ts: new Date().toISOString(), app: GADGET_APP, environment: GADGET_ENVIRONMENT, ...entry }) + "\n",
      "utf8"
    );
  } catch (err: any) {
    console.error(`gadget-mcp: could not write audit log ${file}: ${err?.message ?? String(err)}`);
  }
}

const ERRORS_SELECTION = `errors { message code ... on InvalidRecordError { validationErrors { apiIdentifier message } } }`;

function isDeleteAction(name: string): boolean {
  return /^(bulk)?delete/i.test(name);
}

/**
 * Execute a Gadget action mutation. Only args the action declares are sent, each typed
 * from introspection. Returns the action result, or an MCP error if success is false.
 */
async function runMutation(
  action: string,
  args: Record<string, unknown>,
  selection: string,
  dryRun = false
): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
  const resolved = await resolveMutation(action);
  if (!resolved) {
    return {
      content: [{ type: "text", text: `No action "${action}" found. Use introspect_actions to see available actions.` }],
      isError: true,
    };
  }

  const unknown = Object.keys(args).filter((k) => !resolved.args.some((a) => a.name === k));
  if (unknown.length) {
    return {
      content: [{
        type: "text",
        text: `Unknown argument(s) for ${action}: ${unknown.join(", ")}. Accepted: ${resolved.args.map((a) => `${a.name}: ${a.type}`).join(", ") || "(none)"}`,
      }],
      isError: true,
    };
  }

  const used = resolved.args.filter((a) => args[a.name] !== undefined);
  const varsDef = used.length ? `(${used.map((a) => `$${a.name}: ${a.type}`).join(", ")})` : "";
  const argsClause = used.length ? `(${used.map((a) => `${a.name}: $${a.name}`).join(", ")})` : "";

  const query = `
    mutation RunAction${varsDef} {
      ${action}${argsClause} {
        ${selection}
      }
    }
  `;

  const variables = used.length ? args : undefined;

  if (dryRun) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          dryRun: true,
          message: "Nothing was changed. Re-run without dry_run to execute.",
          action,
          variables: variables ?? {},
          query: query.replace(/\n\s+/g, " ").trim(),
        }, null, 2),
      }],
    };
  }

  let result: any;
  try {
    const data = await gql(query, variables);
    result = data[action];
  } catch (err: any) {
    auditLog({ action, variables, success: false, error: err?.message ?? String(err) });
    throw err;
  }
  auditLog({ action, variables, success: result?.success !== false, errors: result?.errors ?? undefined });

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    ...(result?.success === false ? { isError: true } : {}),
  };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
            content: [{
              type: "text",
              text: "Mutations are not allowed in run_graphql. " +
                (writesEnabled()
                  ? "Use create_record, update_record, delete_record, or run_action instead."
                  : "This server is read-only; set GADGET_ALLOW_WRITES=true to enable write tools."),
            }],
            isError: true,
          };
        }
        const data = await gql(query, variables);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "create_record": {
        if (!writesEnabled()) return { content: [{ type: "text", text: WRITES_DISABLED_MSG }], isError: true };
        const { model, data, fields = "id", dry_run } = args as {
          model: string; data: Record<string, unknown>; fields?: string; dry_run?: boolean;
        };
        return runMutation(
          `create${capitalize(model)}`,
          { [model]: data },
          `success ${ERRORS_SELECTION} ${model} { ${fields} }`,
          dry_run
        );
      }

      case "update_record": {
        if (!writesEnabled()) return { content: [{ type: "text", text: WRITES_DISABLED_MSG }], isError: true };
        const { model, id, data, fields = "id", dry_run } = args as {
          model: string; id: string; data: Record<string, unknown>; fields?: string; dry_run?: boolean;
        };
        return runMutation(
          `update${capitalize(model)}`,
          { id, [model]: data },
          `success ${ERRORS_SELECTION} ${model} { ${fields} }`,
          dry_run
        );
      }

      case "delete_record": {
        if (!deletesEnabled()) return { content: [{ type: "text", text: DELETES_DISABLED_MSG }], isError: true };
        const { model, id, dry_run } = args as { model: string; id: string; dry_run?: boolean };
        return runMutation(`delete${capitalize(model)}`, { id }, `success ${ERRORS_SELECTION}`, dry_run);
      }

      case "run_action": {
        if (!writesEnabled()) return { content: [{ type: "text", text: WRITES_DISABLED_MSG }], isError: true };
        const { action, args: actionArgs = {}, fields = "", dry_run } = args as {
          action: string; args?: Record<string, unknown>; fields?: string; dry_run?: boolean;
        };
        if (isDeleteAction(action) && !deletesEnabled()) {
          return { content: [{ type: "text", text: DELETES_DISABLED_MSG }], isError: true };
        }
        return runMutation(action, actionArgs, `success ${ERRORS_SELECTION} ${fields}`, dry_run);
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
/** Read-only tools — always available */
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
      "List all actions (mutations) available in this Gadget app, including their arguments. Use this to find action names and argument shapes for run_action, create_record, and update_record.",
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

const WRITE_TOOL_DEFINITIONS = [
  {
    name: "create_record",
    description:
      "Create a record by running the model's create action. Enabled by GADGET_ALLOW_WRITES. Use introspect_actions to see the create input shape (e.g. CreateLabelInput).",
    inputSchema: {
      type: "object",
      required: ["model", "data"],
      properties: {
        model: { type: "string", description: "Model name in singular camelCase, e.g. label, shopifyOrder" },
        data: { type: "object", description: "Field values for the new record, e.g. { \"name\": \"VIP\" }" },
        fields: { type: "string", description: "GraphQL field selection to return for the created record (default \"id\")" },
        dry_run: { type: "boolean", description: "Validate the action and arguments and return the mutation that would run, without changing anything" },
      },
    },
  },
  {
    name: "update_record",
    description:
      "Update a record by running the model's update action. Enabled by GADGET_ALLOW_WRITES. Only the fields in data are changed.",
    inputSchema: {
      type: "object",
      required: ["model", "id", "data"],
      properties: {
        model: { type: "string", description: "Model name in singular camelCase, e.g. label, shopifyOrder" },
        id: { type: "string", description: "Record ID" },
        data: { type: "object", description: "Field values to change, e.g. { \"name\": \"VIP\" }" },
        fields: { type: "string", description: "GraphQL field selection to return for the updated record (default \"id\")" },
        dry_run: { type: "boolean", description: "Validate the action and arguments and return the mutation that would run, without changing anything" },
      },
    },
  },
  {
    name: "run_action",
    description:
      "Run any Gadget action (model or global) by its mutation name, e.g. publishBlogPost or syncProducts. Enabled by GADGET_ALLOW_WRITES; delete actions also need GADGET_ALLOW_DELETES. Use introspect_actions to discover action names and arguments.",
    inputSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", description: "Mutation name as listed by introspect_actions, e.g. publishBlogPost" },
        args: { type: "object", description: "Action arguments keyed by argument name, e.g. { \"id\": \"1\", \"blogPost\": { ... } }" },
        fields: {
          type: "string",
          description: "Extra selection on the action result, e.g. \"blogPost { id title }\" for model actions or \"result\" for global actions",
        },
        dry_run: { type: "boolean", description: "Validate the action and arguments and return the mutation that would run, without changing anything" },
      },
    },
  },
];

const DELETE_TOOL_DEFINITIONS = [
  {
    name: "delete_record",
    description: "Permanently delete a record by running the model's delete action. Enabled by GADGET_ALLOW_DELETES.",
    inputSchema: {
      type: "object",
      required: ["model", "id"],
      properties: {
        model: { type: "string", description: "Model name in singular camelCase, e.g. label, shopifyOrder" },
        id: { type: "string", description: "Record ID" },
        dry_run: { type: "boolean", description: "Validate the action and arguments and return the mutation that would run, without changing anything" },
      },
    },
  },
];

/** Tools exposed to the client, based on which write flags are enabled */
export function getToolDefinitions() {
  return [
    ...TOOL_DEFINITIONS,
    ...(writesEnabled() ? WRITE_TOOL_DEFINITIONS : []),
    ...(deletesEnabled() ? DELETE_TOOL_DEFINITIONS : []),
  ];
}

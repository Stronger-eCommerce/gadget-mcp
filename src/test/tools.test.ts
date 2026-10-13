import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ── Mock fetch before importing the module under test ─────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Set required env vars before the module initialises
process.env.GADGET_APP = "test-app";
process.env.GADGET_API_KEY = "test-key-1234";

// Dynamically import so env vars are set first
const { gql, handleTool, _resetCaches, getToolDefinitions, _retry, redactRecords } = await import("../tools.js");
_retry.baseDelayMs = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
function mockGql(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ data }),
  } as Response);
}

function mockGqlError(message: string) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ errors: [{ message }] }),
  } as Response);
}

beforeEach(() => {
  mockFetch.mockReset();
  _resetCaches();
  delete process.env.GADGET_ALLOW_WRITES;
  delete process.env.GADGET_ALLOW_DELETES;
  delete process.env.GADGET_AUDIT_LOG;
  delete process.env.GADGET_REDACT_FIELDS;
  delete process.env.GADGET_WRITE_MODELS;
});

// ── gql helper ────────────────────────────────────────────────────────────────
describe("gql", () => {
  it("sends the correct headers and body", async () => {
    mockGql({ hello: "world" });
    await gql("query { hello }");
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://test-app.gadget.app/api/graphql");
    const body = JSON.parse(opts.body as string);
    expect(body.query).toBe("query { hello }");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key-1234");
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => "Unauthorized" } as Response);
    await expect(gql("query { x }")).rejects.toThrow("GraphQL HTTP 401");
  });

  it("throws on GraphQL errors", async () => {
    mockGqlError("field not found");
    await expect(gql("query { x }")).rejects.toThrow("field not found");
  });
});

// ── list_models ───────────────────────────────────────────────────────────────
describe("list_models", () => {
  it("returns filtered model list", async () => {
    mockGql({
      __schema: {
        queryType: {
          fields: [
            { name: "shopifyOrder", description: "Orders", type: { name: "ShopifyOrderConnection", kind: "OBJECT" } },
            { name: "__schema", description: null, type: { name: "__Schema", kind: "OBJECT" } },
            { name: "currentSession", description: null, type: { name: "Session", kind: "OBJECT" } },
          ],
        },
      },
    });
    const result = await handleTool("list_models", {});
    const models = JSON.parse(result.content[0].text);
    expect(models).toHaveLength(2); // __schema filtered out, but currentSession and shopifyOrder included
    expect(models.find((m: any) => m.name === "shopifyOrder")).toBeDefined();
    expect(models.find((m: any) => m.name === "__schema")).toBeUndefined();
  });
});

// ── introspect_model ──────────────────────────────────────────────────────────
describe("introspect_model", () => {
  it("returns type fields", async () => {
    mockGql({
      __type: {
        name: "ShopifyOrder",
        fields: [
          { name: "id", description: null, type: { name: "ID", kind: "SCALAR", ofType: null } },
          { name: "name", description: null, type: { name: "String", kind: "SCALAR", ofType: null } },
        ],
      },
    });
    const result = await handleTool("introspect_model", { model: "shopifyOrder" });
    const type = JSON.parse(result.content[0].text);
    expect(type.name).toBe("ShopifyOrder");
    expect(type.fields).toHaveLength(2);
  });

  it("returns helpful message when type not found", async () => {
    mockGql({ __type: null });
    const result = await handleTool("introspect_model", { model: "doesNotExist" });
    expect(result.content[0].text).toContain("No type found");
  });
});

// ── query_records ─────────────────────────────────────────────────────────────

// Introspection response that resolves "shopifyOrder" → "shopifyOrders" connection
const shopifyOrderIntrospection = {
  __schema: {
    queryType: {
      fields: [
        {
          name: "shopifyOrders",
          args: [
            {
              name: "filter",
              type: { kind: "LIST", name: null, ofType: { kind: "NON_NULL", name: null, ofType: { kind: "INPUT_OBJECT", name: "ShopifyOrderFilter", ofType: null } } },
            },
            {
              name: "sort",
              type: { kind: "LIST", name: null, ofType: { kind: "NON_NULL", name: null, ofType: { kind: "INPUT_OBJECT", name: "ShopifyOrderSort", ofType: null } } },
            },
          ],
          type: { kind: "NON_NULL", name: null, ofType: { kind: "OBJECT", name: "ShopifyOrderConnection", ofType: null } },
        },
      ],
    },
  },
};

describe("query_records", () => {
  it("returns records array with endCursor", async () => {
    mockGql(shopifyOrderIntrospection);
    mockGql({
      shopifyOrders: {
        edges: [
          { node: { id: "1", name: "#1001" } },
          { node: { id: "2", name: "#1002" } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const result = await handleTool("query_records", { model: "shopifyOrder", fields: "id name" });
    const { records, hasMore, endCursor } = JSON.parse(result.content[0].text);
    expect(records).toHaveLength(2);
    expect(records[0].name).toBe("#1001");
    expect(hasMore).toBe(false);
    expect(endCursor).toBeNull();
  });

  it("caps limit at 50", async () => {
    mockGql(shopifyOrderIntrospection);
    mockGql({ shopifyOrders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await handleTool("query_records", { model: "shopifyOrder", fields: "id", limit: 999 });
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.variables.first).toBe(50);
  });

  it("passes sort variable when sort is provided", async () => {
    mockGql(shopifyOrderIntrospection);
    mockGql({ shopifyOrders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    const sort = [{ createdAt: { sortOrder: "Descending" } }];
    await handleTool("query_records", { model: "shopifyOrder", fields: "id", sort });
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.variables.sort).toEqual(sort);
    expect(body.query).toContain("$sort:");
    expect(body.query).toContain("sort: $sort");
  });

  it("passes after cursor for pagination", async () => {
    mockGql(shopifyOrderIntrospection);
    mockGql({
      shopifyOrders: {
        edges: [{ node: { id: "3", name: "#1003" } }],
        pageInfo: { hasNextPage: false, endCursor: "cursor-xyz" },
      },
    });
    await handleTool("query_records", { model: "shopifyOrder", fields: "id name", after: "cursor-abc" });
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.variables.after).toBe("cursor-abc");
    expect(body.query).toContain("$after: String");
    expect(body.query).toContain("after: $after");
  });

  it("returns endCursor from pageInfo", async () => {
    mockGql(shopifyOrderIntrospection);
    mockGql({
      shopifyOrders: {
        edges: [{ node: { id: "1" } }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-page2" },
      },
    });
    const result = await handleTool("query_records", { model: "shopifyOrder", fields: "id" });
    const { hasMore, endCursor } = JSON.parse(result.content[0].text);
    expect(hasMore).toBe(true);
    expect(endCursor).toBe("cursor-page2");
  });

  it("returns error when model has no connection field", async () => {
    mockGql({ __schema: { queryType: { fields: [] } } });
    const result = await handleTool("query_records", { model: "unknownModel", fields: "id" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No connection field found");
  });
});

// ── count_records ─────────────────────────────────────────────────────────────
describe("count_records", () => {
  it("returns the record count", async () => {
    mockGql(shopifyOrderIntrospection);
    mockGql({ shopifyOrders: { count: 42 } });
    const result = await handleTool("count_records", { model: "shopifyOrder" });
    const { count } = JSON.parse(result.content[0].text);
    expect(count).toBe(42);
  });

  it("passes filter when provided", async () => {
    mockGql(shopifyOrderIntrospection);
    mockGql({ shopifyOrders: { count: 5 } });
    const filter = [{ financialStatus: { equals: "paid" } }];
    await handleTool("count_records", { model: "shopifyOrder", filter });
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.variables.filter).toEqual(filter);
    expect(body.query).toContain("$filter:");
  });

  it("returns error when model not found", async () => {
    mockGql({ __schema: { queryType: { fields: [] } } });
    const result = await handleTool("count_records", { model: "missing" });
    expect(result.isError).toBe(true);
  });
});

// ── get_record ────────────────────────────────────────────────────────────────
describe("get_record", () => {
  it("returns a single record", async () => {
    mockGql({ shopifyOrder: { id: "42", name: "#1042" } });
    const result = await handleTool("get_record", { model: "shopifyOrder", id: "42", fields: "id name" });
    const record = JSON.parse(result.content[0].text);
    expect(record.id).toBe("42");
  });
});

// ── introspect_filters ────────────────────────────────────────────────────────
describe("introspect_filters", () => {
  it("returns filter input fields", async () => {
    mockGql(shopifyOrderIntrospection);
    mockGql({
      __type: {
        name: "ShopifyOrderFilter",
        inputFields: [
          { name: "id", description: null, type: { name: "IDFilter", kind: "INPUT_OBJECT", ofType: null } },
          { name: "financialStatus", description: null, type: { name: "StringFilter", kind: "INPUT_OBJECT", ofType: null } },
        ],
      },
    });
    const result = await handleTool("introspect_filters", { model: "shopifyOrder" });
    const type = JSON.parse(result.content[0].text);
    expect(type.name).toBe("ShopifyOrderFilter");
    expect(type.inputFields).toHaveLength(2);
  });

  it("returns error when model not found", async () => {
    mockGql({ __schema: { queryType: { fields: [] } } });
    const result = await handleTool("introspect_filters", { model: "missing" });
    expect(result.isError).toBe(true);
  });
});

// ── introspect_actions ────────────────────────────────────────────────────────
describe("introspect_actions", () => {
  it("returns mutation list", async () => {
    mockGql({
      __schema: {
        mutationType: {
          fields: [
            {
              name: "createShopifyOrder",
              description: "Create an order",
              args: [
                { name: "shopifyOrder", description: null, type: { name: null, kind: "INPUT_OBJECT", ofType: { name: "CreateShopifyOrderInput", kind: "INPUT_OBJECT", ofType: null } } },
              ],
            },
            {
              name: "deleteShopifyOrder",
              description: "Delete an order",
              args: [
                { name: "id", description: null, type: { name: "GadgetID", kind: "SCALAR", ofType: null } },
              ],
            },
          ],
        },
      },
    });
    const result = await handleTool("introspect_actions", {});
    const actions = JSON.parse(result.content[0].text);
    expect(actions).toHaveLength(2);
    expect(actions[0].name).toBe("createShopifyOrder");
    expect(actions[0].args[0].name).toBe("shopifyOrder");
  });

  it("handles schema with no mutations", async () => {
    mockGql({ __schema: { mutationType: null } });
    const result = await handleTool("introspect_actions", {});
    expect(result.content[0].text).toContain("No actions");
  });
});

// ── get_schema_overview ───────────────────────────────────────────────────────
describe("get_schema_overview", () => {
  it("returns all models with fields", async () => {
    mockGql({
      __schema: {
        queryType: {
          fields: [
            { name: "labels", type: { kind: "OBJECT", name: "LabelConnection", ofType: null } },
            { name: "shopifyOrders", type: { kind: "NON_NULL", name: null, ofType: { kind: "OBJECT", name: "ShopifyOrderConnection" } } },
          ],
        },
        types: [
          {
            name: "Label",
            kind: "OBJECT",
            description: "A label",
            fields: [
              { name: "id", description: null, type: { name: "ID", kind: "SCALAR", ofType: null } },
              { name: "name", description: null, type: { name: "String", kind: "SCALAR", ofType: null } },
            ],
          },
          {
            name: "ShopifyOrder",
            kind: "OBJECT",
            description: null,
            fields: [
              { name: "id", description: null, type: { name: "ID", kind: "SCALAR", ofType: null } },
            ],
          },
          {
            name: "LabelConnection",
            kind: "OBJECT",
            description: null,
            fields: [{ name: "edges", description: null, type: { name: null, kind: "LIST", ofType: { name: "LabelEdge", kind: "OBJECT", ofType: null } } }],
          },
        ],
      },
    });
    const result = await handleTool("get_schema_overview", {});
    const models = JSON.parse(result.content[0].text);
    // Only Label and ShopifyOrder — LabelConnection is excluded
    expect(models).toHaveLength(2);
    expect(models.find((m: any) => m.name === "Label")).toBeDefined();
    expect(models.find((m: any) => m.name === "ShopifyOrder")).toBeDefined();
    expect(models.find((m: any) => m.name === "LabelConnection")).toBeUndefined();
    // Models sorted alphabetically
    expect(models[0].name).toBe("Label");
    expect(models[1].name).toBe("ShopifyOrder");
  });
});

// ── run_graphql ───────────────────────────────────────────────────────────────
describe("run_graphql", () => {
  it("executes a read query", async () => {
    mockGql({ shopifyShop: { id: "1", name: "Test Shop" } });
    const result = await handleTool("run_graphql", { query: "query { shopifyShop { id name } }" });
    const data = JSON.parse(result.content[0].text);
    expect(data.shopifyShop.name).toBe("Test Shop");
  });

  it("blocks mutations", async () => {
    const result = await handleTool("run_graphql", { query: "mutation { deleteOrder(id: 1) { id } }" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("read-only");
  });
});

// ── write / delete tools ──────────────────────────────────────────────────────
const NON_NULL = (ofType: any) => ({ kind: "NON_NULL", name: null, ofType });
const mutationIntrospection = {
  __schema: {
    mutationType: {
      fields: [
        { name: "createLabel", args: [{ name: "label", type: { kind: "INPUT_OBJECT", name: "CreateLabelInput", ofType: null } }] },
        {
          name: "updateLabel",
          args: [
            { name: "id", type: NON_NULL({ kind: "SCALAR", name: "GadgetID", ofType: null }) },
            { name: "label", type: { kind: "INPUT_OBJECT", name: "UpdateLabelInput", ofType: null } },
          ],
        },
        { name: "deleteLabel", args: [{ name: "id", type: NON_NULL({ kind: "SCALAR", name: "GadgetID", ofType: null }) }] },
        { name: "syncProducts", args: [] },
      ],
    },
  },
};

describe("tool definitions", () => {
  const names = () => getToolDefinitions().map((t: any) => t.name);

  it("exposes only read tools by default", () => {
    expect(names()).not.toContain("create_record");
    expect(names()).not.toContain("delete_record");
  });

  it("exposes write tools when GADGET_ALLOW_WRITES=true", () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    expect(names()).toEqual(expect.arrayContaining(["create_record", "update_record", "run_action"]));
    expect(names()).not.toContain("delete_record");
  });

  it("exposes delete tool when GADGET_ALLOW_DELETES=true", () => {
    process.env.GADGET_ALLOW_DELETES = "1";
    expect(names()).toContain("delete_record");
    expect(names()).not.toContain("create_record");
  });
});

describe("create_record", () => {
  it("is refused when writes are disabled", async () => {
    const result = await handleTool("create_record", { model: "label", data: { name: "VIP" } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GADGET_ALLOW_WRITES");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("runs the create mutation with typed variables", async () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    mockGql(mutationIntrospection);
    mockGql({ createLabel: { success: true, errors: null, label: { id: "7", name: "VIP" } } });
    const result = await handleTool("create_record", { model: "label", data: { name: "VIP" }, fields: "id name" });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).label.id).toBe("7");
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.query).toContain("mutation RunAction($label: CreateLabelInput)");
    expect(body.query).toContain("createLabel(label: $label)");
    expect(body.query).toContain("label { id name }");
    expect(body.variables).toEqual({ label: { name: "VIP" } });
  });

  it("returns isError when the action reports success: false", async () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    mockGql(mutationIntrospection);
    mockGql({ createLabel: { success: false, errors: [{ message: "name is required", code: "GGT_INVALID_RECORD" }], label: null } });
    const result = await handleTool("create_record", { model: "label", data: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("name is required");
  });

  it("returns error when the model has no create action", async () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    mockGql(mutationIntrospection);
    const result = await handleTool("create_record", { model: "widget", data: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No action "createWidget"');
  });
});

describe("update_record", () => {
  it("passes id and model input", async () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    mockGql(mutationIntrospection);
    mockGql({ updateLabel: { success: true, errors: null, label: { id: "7" } } });
    await handleTool("update_record", { model: "label", id: "7", data: { name: "Gold" } });
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.query).toContain("$id: GadgetID!");
    expect(body.query).toContain("updateLabel(id: $id, label: $label)");
    expect(body.variables).toEqual({ id: "7", label: { name: "Gold" } });
  });
});

describe("delete_record", () => {
  it("is refused when deletes are disabled, even with writes on", async () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    const result = await handleTool("delete_record", { model: "label", id: "7" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GADGET_ALLOW_DELETES");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("runs the delete mutation when enabled", async () => {
    process.env.GADGET_ALLOW_DELETES = "true";
    mockGql(mutationIntrospection);
    mockGql({ deleteLabel: { success: true, errors: null } });
    const result = await handleTool("delete_record", { model: "label", id: "7" });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.query).toContain("deleteLabel(id: $id)");
    expect(body.variables).toEqual({ id: "7" });
  });
});

describe("run_action", () => {
  it("runs a global action with no args", async () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    mockGql(mutationIntrospection);
    mockGql({ syncProducts: { success: true, errors: null, result: { synced: 3 } } });
    const result = await handleTool("run_action", { action: "syncProducts", fields: "result" });
    expect(JSON.parse(result.content[0].text).result.synced).toBe(3);
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.query).toContain("syncProducts {");
    expect(body.variables).toBeUndefined();
  });

  it("rejects unknown arguments", async () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    mockGql(mutationIntrospection);
    const result = await handleTool("run_action", { action: "updateLabel", args: { id: "1", bogus: true } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bogus");
  });

  it("blocks delete actions unless deletes are enabled", async () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    const result = await handleTool("run_action", { action: "bulkDeleteLabels", args: { ids: ["1"] } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("GADGET_ALLOW_DELETES");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("dry_run", () => {
  it("validates and previews the mutation without executing it", async () => {
    process.env.GADGET_ALLOW_DELETES = "true";
    mockGql(mutationIntrospection);
    const result = await handleTool("delete_record", { model: "label", id: "7", dry_run: true });
    expect(mockFetch).toHaveBeenCalledTimes(1); // introspection only
    const preview = JSON.parse(result.content[0].text);
    expect(preview.dryRun).toBe(true);
    expect(preview.action).toBe("deleteLabel");
    expect(preview.variables).toEqual({ id: "7" });
    expect(preview.query).toContain("deleteLabel(id: $id)");
  });

  it("still reports unknown actions", async () => {
    process.env.GADGET_ALLOW_WRITES = "true";
    mockGql(mutationIntrospection);
    const result = await handleTool("run_action", { action: "nope", dry_run: true });
    expect(result.isError).toBe(true);
  });
});

describe("audit log", () => {
  const logFile = () => join(mkdtempSync(join(tmpdir(), "gadget-mcp-")), "nested", "audit.jsonl");

  it("appends a JSON line for each executed write", async () => {
    const file = logFile();
    process.env.GADGET_AUDIT_LOG = file;
    process.env.GADGET_ALLOW_WRITES = "true";
    mockGql(mutationIntrospection);
    mockGql({ updateLabel: { success: true, errors: null, label: { id: "7" } } });
    mockGql({ updateLabel: { success: false, errors: [{ message: "bad", code: "X" }], label: null } });
    await handleTool("update_record", { model: "label", id: "7", data: { name: "Gold" } });
    await handleTool("update_record", { model: "label", id: "7", data: { name: "" } });

    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ app: "test-app", action: "updateLabel", success: true, variables: { id: "7", label: { name: "Gold" } } });
    expect(lines[1]).toMatchObject({ success: false, errors: [{ message: "bad" }] });
    expect(lines[0].ts).toBeDefined();
  });

  it("does not log dry runs", async () => {
    const file = logFile();
    process.env.GADGET_AUDIT_LOG = file;
    process.env.GADGET_ALLOW_WRITES = "true";
    mockGql(mutationIntrospection);
    await handleTool("create_record", { model: "label", data: { name: "x" }, dry_run: true });
    expect(existsSync(file)).toBe(false);
  });
});

// ── report_bug ────────────────────────────────────────────────────────────────
describe("report_bug", () => {
  it("returns a pre-filled issue link without calling Gadget", async () => {
    const result = await handleTool("report_bug", {
      title: "filter broken",
      what_happened: "count_records errored",
      error_output: "Error: test-key-1234 rejected",
    });
    expect(mockFetch).not.toHaveBeenCalled();
    const url = result.content[0].text.match(/https:\/\/github\.com\/\S+/)![0];
    const p = new URL(url).searchParams;
    expect(p.get("title")).toBe("[Bug]: filter broken");
    expect(p.get("logs")).not.toContain("test-key-1234");
    expect(p.get("diagnostics")).toContain("gadget-mcp:");
  });

  it("is always listed, even read-only", () => {
    expect(getToolDefinitions().map((t: any) => t.name)).toContain("report_bug");
  });
});

// ── retry on throttling ───────────────────────────────────────────────────────
describe("gql retries", () => {
  const throttled = (status = 429, retryAfter: string | null = null) =>
    mockFetch.mockResolvedValueOnce({
      ok: false, status, headers: { get: () => retryAfter }, text: async () => "slow down",
    } as unknown as Response);

  it("retries a throttled request and succeeds", async () => {
    throttled();
    throttled(503, "0");
    mockGql({ ok: true });
    expect(await gql("query { ok }")).toEqual({ ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("gives up after 3 retries", async () => {
    for (let i = 0; i < 4; i++) throttled();
    await expect(gql("query { x }")).rejects.toThrow("GraphQL HTTP 429");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("does not retry other errors", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, headers: { get: () => null }, text: async () => "no" } as unknown as Response);
    await expect(gql("query { x }")).rejects.toThrow("401");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── automatic field selection ─────────────────────────────────────────────────
const SCALAR = (name: string) => ({ kind: "SCALAR", name, ofType: null });
const orderType = {
  __type: {
    fields: [
      { name: "id", type: NON_NULL(SCALAR("GadgetID")) },
      { name: "email", type: SCALAR("String") },
      { name: "financialStatus", type: { kind: "ENUM", name: "Status", ofType: null } },
      { name: "tags", type: { kind: "LIST", name: null, ofType: SCALAR("String") } },
      { name: "customer", type: { kind: "OBJECT", name: "ShopifyCustomer", ofType: null } },
    ],
  },
};

describe("field selection", () => {
  it("selects every scalar field when fields is omitted", async () => {
    mockGql(shopifyOrderIntrospection);
    mockGql(orderType);
    mockGql({ shopifyOrders: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await handleTool("query_records", { model: "shopifyOrder" });
    const body = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(body.query).toMatch(/node \{\s+id email financialStatus tags\s+\}/);
    expect(body.query).not.toContain("customer");
  });

  it("expands * alongside relations and caches the field list", async () => {
    mockGql(orderType);
    mockGql({ shopifyOrder: { id: "1" } });
    mockGql({ shopifyOrder: { id: "2" } });
    await handleTool("get_record", { model: "shopifyOrder", id: "1", fields: "* customer { email }" });
    await handleTool("get_record", { model: "shopifyOrder", id: "2", fields: "*" });
    expect(mockFetch).toHaveBeenCalledTimes(3); // type introspected once
    const body = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(body.query).toContain("id email financialStatus tags customer { email }");
  });

  it("leaves explicit selections untouched", async () => {
    mockGql({ shopifyOrder: { id: "1" } });
    await handleTool("get_record", { model: "shopifyOrder", id: "1", fields: "id name" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── redaction ─────────────────────────────────────────────────────────────────
describe("redaction", () => {
  it("hides personal fields anywhere in the result with the pii preset", async () => {
    process.env.GADGET_REDACT_FIELDS = "pii";
    mockGql({
      shopifyOrder: {
        id: "1", name: "#1001", email: "a@b.com", contactEmail: "x@y.com",
        customer: { firstName: "Ada", phone: "555", defaultAddress: { city: "X" }, tags: ["vip"] },
        note: null,
      },
    });
    const result = await handleTool("get_record", { model: "shopifyOrder", id: "1", fields: "id name" });
    const record = JSON.parse(result.content[0].text);
    expect(record).toMatchObject({
      id: "1", name: "#1001", email: "[REDACTED]", contactEmail: "[REDACTED]",
      customer: { firstName: "[REDACTED]", phone: "[REDACTED]", defaultAddress: "[REDACTED]", tags: ["vip"] },
      note: null,
    });
    expect(result.content[0].text).not.toContain("a@b.com");
  });

  it("supports custom patterns and leaves data alone when unset", () => {
    process.env.GADGET_REDACT_FIELDS = "secret*, ssn";
    expect(redactRecords({ secretNote: "x", SSN: "1", other: "ok" })).toEqual({ secretNote: "[REDACTED]", SSN: "[REDACTED]", other: "ok" });
    delete process.env.GADGET_REDACT_FIELDS;
    expect(redactRecords({ email: "a@b.com" })).toEqual({ email: "a@b.com" });
  });

  it("applies to run_graphql results", async () => {
    process.env.GADGET_REDACT_FIELDS = "email";
    mockGql({ shopifyShop: { email: "owner@shop.com" } });
    const result = await handleTool("run_graphql", { query: "query { shopifyShop { email } }" });
    expect(JSON.parse(result.content[0].text).shopifyShop.email).toBe("[REDACTED]");
  });

  it("refuses aliases that could rename a redacted field", async () => {
    process.env.GADGET_REDACT_FIELDS = "email";
    const r1 = await handleTool("run_graphql", { query: "query { shopifyShop { e: email } }" });
    const r2 = await handleTool("get_record", { model: "shopifyOrder", id: "1", fields: "id e: email" });
    process.env.GADGET_ALLOW_WRITES = "true";
    const r3 = await handleTool("update_record", { model: "label", id: "1", data: {}, fields: "id e: email" });
    expect(r1.isError).toBe(true);
    expect(r2.isError).toBe(true);
    expect(r3.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("allows colons in arguments and variables", async () => {
    process.env.GADGET_REDACT_FIELDS = "email";
    mockGql({ shopifyOrders: { edges: [] } });
    const result = await handleTool("run_graphql", {
      query: 'query Q($n: Int) { shopifyOrders(first: $n, filter: { name: { equals: "a:b" } }) { edges { node { id } } } }',
      variables: { n: 1 },
    });
    expect(result.isError).toBeUndefined();
  });
});

// ── write allowlist ───────────────────────────────────────────────────────────
const OBJ = (name: string) => ({ kind: "OBJECT", name, ofType: null });
const resultType = (model?: string) => ({
  kind: "OBJECT", name: "Result",
  fields: [
    { name: "success", type: NON_NULL(SCALAR("Boolean")) },
    ...(model ? [{ name: model.charAt(0).toLowerCase() + model.slice(1), type: OBJ(model) }] : [{ name: "result", type: SCALAR("JSON") }]),
  ],
});
const allowlistIntrospection = {
  __schema: {
    mutationType: {
      fields: [
        { name: "createLabel", args: [{ name: "label", type: { kind: "INPUT_OBJECT", name: "CreateLabelInput", ofType: null } }], type: resultType("Label") },
        { name: "publishBlogPost", args: [{ name: "id", type: NON_NULL(SCALAR("GadgetID")) }], type: { kind: "NON_NULL", name: null, fields: null, ofType: resultType("BlogPost") } },
        { name: "syncProducts", args: [], type: resultType() },
      ],
    },
  },
};

describe("GADGET_WRITE_MODELS", () => {
  beforeEach(() => {
    process.env.GADGET_ALLOW_WRITES = "true";
    process.env.GADGET_WRITE_MODELS = "blogPost, syncProducts";
  });

  it("blocks models that aren't listed", async () => {
    mockGql(allowlistIntrospection);
    const result = await handleTool("create_record", { model: "label", data: { name: "x" } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('model "label"');
    expect(mockFetch).toHaveBeenCalledTimes(1); // introspection only
  });

  it("allows actions on listed models, including non-null result types", async () => {
    mockGql(allowlistIntrospection);
    mockGql({ publishBlogPost: { success: true, errors: null } });
    const result = await handleTool("run_action", { action: "publishBlogPost", args: { id: "1" } });
    expect(result.isError).toBeUndefined();
  });

  it("matches global actions by name", async () => {
    mockGql(allowlistIntrospection);
    const dry = await handleTool("run_action", { action: "syncProducts", dry_run: true });
    expect(JSON.parse(dry.content[0].text).dryRun).toBe(true);
  });

  it("lists the allowed models in tool descriptions", () => {
    const create = getToolDefinitions().find((t: any) => t.name === "create_record")!;
    expect(create.description).toContain("blogPost, syncProducts");
  });
});

// ── unknown tool ──────────────────────────────────────────────────────────────
describe("unknown tool", () => {
  it("returns isError", async () => {
    const result = await handleTool("not_a_tool", {});
    expect(result.isError).toBe(true);
  });
});

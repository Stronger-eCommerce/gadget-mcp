import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock fetch before importing the module under test ─────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Set required env vars before the module initialises
process.env.GADGET_APP = "test-app";
process.env.GADGET_API_KEY = "test-key-1234";

// Dynamically import so env vars are set first
const { gql, handleTool, _resetCaches } = await import("../tools.js");

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

// ── unknown tool ──────────────────────────────────────────────────────────────
describe("unknown tool", () => {
  it("returns isError", async () => {
    const result = await handleTool("not_a_tool", {});
    expect(result.isError).toBe(true);
  });
});

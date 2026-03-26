import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock fetch before importing the module under test ─────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Set required env vars before the module initialises
process.env.GADGET_APP = "test-app";
process.env.GADGET_API_KEY = "test-key-1234";

// Dynamically import so env vars are set first
const { gql, handleTool } = await import("../tools.js");

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
describe("query_records", () => {
  it("returns records array", async () => {
    mockGql({
      shopifyOrder: {
        edges: [
          { node: { id: "1", name: "#1001" } },
          { node: { id: "2", name: "#1002" } },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const result = await handleTool("query_records", { model: "shopifyOrder", fields: "id name" });
    const { records, hasMore } = JSON.parse(result.content[0].text);
    expect(records).toHaveLength(2);
    expect(records[0].name).toBe("#1001");
    expect(hasMore).toBe(false);
  });

  it("caps limit at 50", async () => {
    mockGql({
      shopifyOrder: { edges: [], pageInfo: { hasNextPage: false } },
    });
    await handleTool("query_records", { model: "shopifyOrder", fields: "id", limit: 999 });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.variables.first).toBe(50);
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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

process.env.GADGET_APP = "test-app";
process.env.GADGET_API_KEY = "test-key-1234";

const { handleTool, _resetCaches } = await import("../tools.js");
const { toCsv, andFilter } = await import("../data-tools.js");

// ── Routing mock: answer each request by inspecting its query ─────────────────
type Handler = (query: string, variables: any) => unknown;
let handler: Handler;
const calls: { query: string; variables: any }[] = [];

beforeEach(() => {
  _resetCaches();
  calls.length = 0;
  delete process.env.GADGET_ALLOW_WRITES;
  delete process.env.GADGET_REDACT_FIELDS;
  delete process.env.GADGET_WRITE_MODELS;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (_url: string, opts: RequestInit) => {
    const { query, variables } = JSON.parse(opts.body as string);
    calls.push({ query, variables });
    return { ok: true, status: 200, json: async () => ({ data: handler(query, variables) }) } as Response;
  });
});

const NN = (ofType: any) => ({ kind: "NON_NULL", name: null, ofType });
const S = (name: string) => ({ kind: "SCALAR", name, ofType: null });

const listIntrospection = {
  __schema: {
    queryType: {
      fields: [{
        name: "shopifyOrders",
        args: [{ name: "filter", type: { kind: "LIST", name: null, ofType: NN({ kind: "INPUT_OBJECT", name: "ShopifyOrderFilter", ofType: null }) } }],
        type: NN({ kind: "OBJECT", name: "ShopifyOrderConnection", ofType: null }),
      }],
    },
  },
};
const orderType = {
  __type: {
    fields: [
      { name: "id", type: NN(S("GadgetID")) },
      { name: "email", type: S("String") },
      { name: "vendor", type: S("String") },
      { name: "test", type: S("Boolean") },
      { name: "financialStatus", type: { kind: "ENUM", name: "FinancialStatus", ofType: null } },
      { name: "customer", type: { kind: "OBJECT", name: "ShopifyCustomer", ofType: null } },
    ],
  },
};

/** Base router for introspection; `rest` handles everything else. */
const route = (rest: Handler): Handler => (q, v) => {
  if (q.includes("queryType")) return listIntrospection;
  if (q.includes("ScalarFields")) return orderType;
  return rest(q, v);
};

const page = (nodes: any[], hasNextPage: boolean, endCursor: string | null = null) =>
  ({ shopifyOrders: { edges: nodes.map((node) => ({ node })), pageInfo: { hasNextPage, endCursor } } });

// ── helpers ───────────────────────────────────────────────────────────────────
describe("toCsv", () => {
  it("flattens nested objects, JSON-encodes arrays and escapes cells", () => {
    const { csv, columns } = toCsv([
      { id: "1", note: 'says "hi", ok', customer: { email: "a@b.com" }, tags: ["a", "b"] },
      { id: "2", extra: "x" },
    ]);
    expect(columns).toEqual(["id", "note", "customer.email", "tags", "extra"]);
    expect(csv.split("\n")[1]).toBe('1,"says ""hi"", ok",a@b.com,"[""a"",""b""]",');
    expect(csv.split("\n")[2]).toBe("2,,,,x");
  });
});

describe("andFilter", () => {
  it("appends to list filters and wraps object filters", () => {
    expect(andFilter("[F!]", undefined, { a: 1 })).toEqual([{ a: 1 }]);
    expect(andFilter("[F!]", { b: 2 }, { a: 1 })).toEqual([{ b: 2 }, { a: 1 }]);
    expect(andFilter("[F!]", [{ b: 2 }], { a: 1 })).toEqual([{ b: 2 }, { a: 1 }]);
    expect(andFilter("F", { b: 2 }, { a: 1 })).toEqual({ AND: [{ b: 2 }, { a: 1 }] });
  });
});

// ── export_records ────────────────────────────────────────────────────────────
describe("export_records", () => {
  it("pages through everything and writes a redacted CSV", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gadget-export-"));
    process.env.GADGET_EXPORT_DIR = dir;
    process.env.GADGET_REDACT_FIELDS = "email";
    handler = route((_q, v) => v.after
      ? page([{ id: "3", email: "c@x.com", vendor: "B" }], false)
      : page([{ id: "1", email: "a@x.com", vendor: "A" }, { id: "2", email: "b@x.com", vendor: "A" }], true, "c1"));

    const result = await handleTool("export_records", { model: "shopifyOrder", filename: "../../etc/orders" });
    const out = JSON.parse(result.content[0].text);
    expect(out.records).toBe(3);
    expect(out.truncated).toBe(false);
    expect(out.file).toBe(join(dir, "orders.csv")); // directories stripped from filename
    const csv = readFileSync(out.file, "utf8");
    expect(csv).toContain("id,email,vendor");
    expect(csv).toContain("1,[REDACTED],A");
    expect(csv).not.toContain("a@x.com");
    // default selection = all scalar fields, Gadget's max page size
    const fetches = calls.filter((c) => c.query.includes("FetchAll"));
    expect(fetches).toHaveLength(2);
    expect(fetches[0].query).toContain("id email vendor test financialStatus");
    expect(fetches[0].variables.first).toBe(250);
  });

  it("stops at max_records and says so", async () => {
    process.env.GADGET_EXPORT_DIR = mkdtempSync(join(tmpdir(), "gadget-export-"));
    handler = route(() => page([{ id: "1" }, { id: "2" }], true, "c1"));
    const out = JSON.parse((await handleTool("export_records", { model: "shopifyOrder", fields: "id", max_records: 2, format: "json" })).content[0].text);
    expect(out.records).toBe(2);
    expect(out.truncated).toBe(true);
    expect(JSON.parse(readFileSync(out.file, "utf8"))).toEqual([{ id: "1" }, { id: "2" }]);
  });
});

// ── group_count ───────────────────────────────────────────────────────────────
describe("group_count", () => {
  it("gives exact counts per enum value, combined with the user filter", async () => {
    const counts: Record<string, number> = { PAID: 7, PENDING: 2, REFUNDED: 0 };
    handler = route((q, v) => {
      if (q.includes("EnumValues")) return { __type: { enumValues: Object.keys(counts).map((name) => ({ name })) } };
      const cond = v.filter[v.filter.length - 1].financialStatus;
      return { shopifyOrders: { count: cond.isSet === false ? 1 : counts[cond.equals] } };
    });
    const out = JSON.parse((await handleTool("group_count", {
      model: "shopifyOrder", field: "financialStatus", filter: { test: { equals: false } },
    })).content[0].text);
    expect(out.exact).toBe(true);
    expect(out.total).toBe(10);
    expect(out.groups).toEqual([{ value: "PAID", count: 7 }, { value: "PENDING", count: 2 }, { value: null, count: 1 }]);
    const countCall = calls.find((c) => c.query.includes("GroupCount"))!;
    expect(countCall.variables.filter[0]).toEqual({ test: { equals: false } });
  });

  it("scans other scalar fields and reports whether that was exact", async () => {
    handler = route((_q, v) => v.after
      ? page([{ vendor: "Acme" }, { vendor: null }], false)
      : page([{ vendor: "Acme" }, { vendor: "Beta" }], true, "c1"));
    const out = JSON.parse((await handleTool("group_count", { model: "shopifyOrder", field: "vendor" })).content[0].text);
    expect(out).toMatchObject({ exact: true, scanned: 4, distinctValues: 3 });
    expect(out.groups[0]).toEqual({ value: "Acme", count: 2 });
  });

  it("refuses relation fields and redacted fields", async () => {
    handler = route(() => ({}));
    const rel = await handleTool("group_count", { model: "shopifyOrder", field: "customer" });
    expect(rel.isError).toBe(true);
    expect(rel.content[0].text).toContain("vendor");
    process.env.GADGET_REDACT_FIELDS = "pii";
    const red = await handleTool("group_count", { model: "shopifyOrder", field: "email" });
    expect(red.isError).toBe(true);
    expect(red.content[0].text).toContain("GADGET_REDACT_FIELDS");
  });
});

// ── bulk_update ───────────────────────────────────────────────────────────────
const mutationIntrospection = {
  __schema: {
    mutationType: {
      fields: [{
        name: "updateShopifyOrder",
        args: [
          { name: "id", type: NN(S("GadgetID")) },
          { name: "shopifyOrder", type: { kind: "INPUT_OBJECT", name: "UpdateShopifyOrderInput", ofType: null } },
        ],
        type: { kind: "OBJECT", name: "R", fields: [{ name: "shopifyOrder", type: { kind: "OBJECT", name: "ShopifyOrder", ofType: null } }] },
      }],
    },
  },
};
const bulkRoute = (ids: string[], failId?: string): Handler => route((q, v) => {
  if (q.includes("mutationType")) return mutationIntrospection;
  if (q.includes("FetchAll")) return page(ids.map((id) => ({ id })), false);
  if (q.includes("RunAction")) {
    return { updateShopifyOrder: v.id === failId
      ? { success: false, errors: [{ message: "invalid", code: "X" }] }
      : { success: true, errors: null } };
  }
  throw new Error(`unexpected query: ${q}`);
});

describe("bulk_update", () => {
  beforeEach(() => { process.env.GADGET_ALLOW_WRITES = "true"; });

  it("requires writes and a filter", async () => {
    delete process.env.GADGET_ALLOW_WRITES;
    expect((await handleTool("bulk_update", { model: "shopifyOrder", filter: {}, data: {} })).isError).toBe(true);
    process.env.GADGET_ALLOW_WRITES = "true";
    const r = await handleTool("bulk_update", { model: "shopifyOrder", data: { note: "x" } });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("needs a filter");
  });

  it("dry run counts matches without changing anything", async () => {
    handler = bulkRoute(["1", "2", "3"]);
    const out = JSON.parse((await handleTool("bulk_update", {
      model: "shopifyOrder", filter: { tags: { matches: "x" } }, data: { note: "hi" }, dry_run: true,
    })).content[0].text);
    expect(out).toMatchObject({ dryRun: true, matched: 3, ids: ["1", "2", "3"] });
    expect(calls.some((c) => c.query.includes("mutation RunAction"))).toBe(false);
  });

  it("refuses when more records match than max_records", async () => {
    handler = route((q) => q.includes("FetchAll") ? page([{ id: "1" }, { id: "2" }, { id: "3" }], true, "c") : {});
    const r = await handleTool("bulk_update", { model: "shopifyOrder", filter: {}, data: {}, max_records: 2 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("more than 2");
  });

  it("updates each match and reports failures", async () => {
    handler = bulkRoute(["1", "2", "3"], "2");
    const result = await handleTool("bulk_update", { model: "shopifyOrder", filter: { a: 1 }, data: { note: "hi" } });
    const out = JSON.parse(result.content[0].text);
    expect(out).toMatchObject({ matched: 3, updated: 2, failed: 1 });
    expect(out.failures[0].id).toBe("2");
    const runs = calls.filter((c) => c.query.includes("mutation RunAction"));
    expect(runs.map((c) => c.variables.id).sort()).toEqual(["1", "2", "3"]);
    expect(runs[0].variables.shopifyOrder).toEqual({ note: "hi" });
  });

  it("respects GADGET_WRITE_MODELS before touching anything", async () => {
    process.env.GADGET_WRITE_MODELS = "label";
    handler = bulkRoute(["1"]);
    const r = await handleTool("bulk_update", { model: "shopifyOrder", filter: { a: 1 }, data: {} });
    expect(r.isError).toBe(true);
    expect(calls.some((c) => c.query.includes("mutation RunAction"))).toBe(false);
  });
});

/**
 * Larger-scale data tools: export to a file, grouped counts, and bulk update.
 * They page through Gadget connections, so they can work past query_records' 50-record limit.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import {
  gql, resolveListField, expandFields, modelFields, redactRecords, runMutation, writesEnabled,
  capitalize, ERRORS_SELECTION, WRITES_DISABLED_MSG,
} from "./tools.js";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

const PAGE_SIZE = 250; // Gadget's maximum page size
const EXPORT_MAX = 100_000;
const GROUP_SCAN_MAX = 20_000;
const BULK_MAX = 1_000;

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError } : {}) });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/** Combine a user filter with an extra condition, matching the connection's filter arg shape. */
export function andFilter(filterArgType: string | undefined, user: unknown, extra: unknown): unknown {
  if (user === undefined) return filterArgType?.startsWith("[") ? [extra] : extra;
  if (filterArgType?.startsWith("[")) return [...(Array.isArray(user) ? user : [user]), extra];
  return { AND: [user, extra] };
}

/** Page through a model's records up to `max`. Returns the records and whether more exist. */
export async function fetchAll(
  model: string,
  fields: string,
  opts: { filter?: unknown; sort?: unknown; max: number }
): Promise<{ records: any[]; hasMore: boolean }> {
  const resolved = await resolveListField(model);
  if (!resolved) throw new Error(`No connection field found for model "${model}". Use list_models to browse available models.`);
  const { fieldName, filterArgType, sortArgType } = resolved;

  const varParts = ["$first: Int", "$after: String"];
  const argParts = ["first: $first", "after: $after"];
  if (opts.filter !== undefined && filterArgType) { varParts.push(`$filter: ${filterArgType}`); argParts.push("filter: $filter"); }
  if (opts.sort !== undefined && sortArgType) { varParts.push(`$sort: ${sortArgType}`); argParts.push("sort: $sort"); }
  const query = `
    query FetchAll(${varParts.join(", ")}) {
      ${fieldName}(${argParts.join(", ")}) {
        edges { node { ${fields} } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const records: any[] = [];
  let after: string | undefined;
  for (;;) {
    const data = await gql(query, {
      first: Math.min(PAGE_SIZE, opts.max - records.length),
      after,
      ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
      ...(opts.sort !== undefined ? { sort: opts.sort } : {}),
    });
    const conn = data[fieldName];
    records.push(...conn.edges.map((e: any) => e.node));
    const more = conn.pageInfo.hasNextPage;
    if (!more) return { records, hasMore: false };
    if (records.length >= opts.max) return { records, hasMore: true };
    after = conn.pageInfo.endCursor;
  }
}

// ── CSV ───────────────────────────────────────────────────────────────────────
/** Flatten nested objects to dot keys ("customer.email"); arrays become JSON strings. */
function flatten(obj: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

export function toCsv(records: Record<string, unknown>[]): { csv: string; columns: string[] } {
  const rows = records.map((r) => flatten(r));
  const columns: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!columns.includes(k)) columns.push(k);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map(cell).join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))];
  return { csv: lines.join("\n") + "\n", columns };
}

export function exportDir(): string {
  return process.env.GADGET_EXPORT_DIR || join(homedir(), "gadget-mcp-exports");
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function handleDataTool(name: string, args: Record<string, any>): Promise<ToolResult | null> {
  switch (name) {
    case "export_records": {
      const { model, filter, sort, format = "csv" } = args as { model: string; filter?: unknown; sort?: unknown; format?: "csv" | "json" };
      const max = Math.min(Math.max(1, args.max_records ?? 10_000), EXPORT_MAX);
      if (format !== "csv" && format !== "json") return text(`format must be "csv" or "json"`, true);

      const fields = await expandFields(model, args.fields);
      const { records, hasMore } = await fetchAll(model, fields, { filter, sort, max });
      const safe = redactRecords(records) as Record<string, unknown>[];

      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const requested = typeof args.filename === "string" && args.filename.trim()
        ? basename(args.filename.trim()).replace(/[^\w.\-]/g, "_")  // no directories, no odd characters
        : `${process.env.GADGET_APP ?? "gadget"}-${model}-${stamp}`;
      const file = join(exportDir(), requested.endsWith(`.${format}`) ? requested : `${requested}.${format}`);
      mkdirSync(exportDir(), { recursive: true });

      let columns: string[];
      if (format === "csv") {
        const out = toCsv(safe);
        columns = out.columns;
        writeFileSync(file, out.csv, "utf8");
      } else {
        columns = [...new Set(safe.flatMap((r) => Object.keys(r)))];
        writeFileSync(file, JSON.stringify(safe, null, 2), "utf8");
      }

      return json({
        file,
        records: safe.length,
        truncated: hasMore,
        ...(hasMore ? { note: `Stopped at max_records (${max}). Raise max_records (up to ${EXPORT_MAX}) or narrow the filter.` } : {}),
        columns,
        preview: safe.slice(0, 3),
      });
    }

    case "group_count": {
      const { model, field, filter } = args as { model: string; field: string; filter?: unknown };
      const fields = await modelFields(model);
      if (!fields) return text(`No type found for model "${model}". Use list_models to check the name.`, true);
      const f = fields.find((x) => x.name === field);
      if (!f || (f.kind !== "SCALAR" && f.kind !== "ENUM")) {
        const options = fields.filter((x) => x.kind === "SCALAR" || x.kind === "ENUM").map((x) => x.name);
        return text(`"${field}" isn't a scalar field on ${model}. Group by one of: ${options.join(", ")}`, true);
      }

      // Grouping by a hidden field would reveal its values
      if ((redactRecords({ [field]: "x" }) as Record<string, unknown>)[field] === "[REDACTED]") {
        return text(`"${field}" is hidden by GADGET_REDACT_FIELDS, so it can't be grouped by.`, true);
      }

      const resolved = await resolveListField(model);
      if (!resolved) return text(`No connection field found for model "${model}".`, true);

      // Enums and booleans: one exact count per value
      let buckets: (string | boolean)[] | null = null;
      if (f.kind === "ENUM") {
        const data = await gql(`query EnumValues($name: String!) { __type(name: $name) { enumValues { name } } }`, { name: f.typeName });
        buckets = (data.__type?.enumValues ?? []).map((v: any) => v.name);
      } else if (f.typeName === "Boolean") {
        buckets = [true, false];
      }

      if (buckets) {
        const count = async (extra: unknown) => {
          const filterVal = andFilter(resolved.filterArgType, filter, extra);
          const data = await gql(
            `query GroupCount($filter: ${resolved.filterArgType}) { ${resolved.fieldName}(filter: $filter) { count } }`,
            { filter: filterVal }
          );
          return data[resolved.fieldName].count as number;
        };
        const groups = await Promise.all(buckets.map(async (v) => ({ value: v, count: await count({ [field]: { equals: v } }) })));
        const unset = await count({ [field]: { isSet: false } }).catch(() => 0);
        if (unset) groups.push({ value: null as any, count: unset });
        groups.sort((a, b) => b.count - a.count);
        return json({ model, field, exact: true, total: groups.reduce((n, g) => n + g.count, 0), groups: groups.filter((g) => g.count > 0) });
      }

      // Other scalars: scan the field and count locally
      const max = Math.min(Math.max(1, args.max_records ?? 10_000), GROUP_SCAN_MAX);
      const { records, hasMore } = await fetchAll(model, field, { filter, max });
      const tally = new Map<string, { value: unknown; count: number }>();
      for (const r of records) {
        const v = r[field] ?? null;
        const key = JSON.stringify(v);
        const t = tally.get(key) ?? { value: v, count: 0 };
        t.count++;
        tally.set(key, t);
      }
      const groups = [...tally.values()].sort((a, b) => b.count - a.count);
      const top = Math.max(1, args.top ?? 50);
      return json({
        model, field,
        exact: !hasMore,
        scanned: records.length,
        ...(hasMore ? { note: `Counted the first ${records.length} records only. Raise max_records (up to ${GROUP_SCAN_MAX}) or narrow the filter for exact numbers.` } : {}),
        distinctValues: groups.length,
        groups: groups.slice(0, top),
      });
    }

    case "bulk_update": {
      if (!writesEnabled()) return text(WRITES_DISABLED_MSG, true);
      const { model, filter, data, dry_run } = args as { model: string; filter: unknown; data: Record<string, unknown>; dry_run?: boolean };
      if (filter === undefined || filter === null || (Array.isArray(filter) && !filter.length)) {
        return text("bulk_update needs a filter. To change every record, pass a filter that matches them all explicitly.", true);
      }
      const max = Math.min(Math.max(1, args.max_records ?? 100), BULK_MAX);
      const action = `update${capitalize(model)}`;

      const { records, hasMore } = await fetchAll(model, "id", { filter, max: max + 1 });
      if (hasMore || records.length > max) {
        return text(`The filter matches more than ${max} records. Narrow the filter or raise max_records (up to ${BULK_MAX}).`, true);
      }
      if (!records.length) return json({ matched: 0, message: "No records match the filter; nothing to update." });
      const ids = records.map((r) => r.id as string);

      // Validates the action, its arguments and GADGET_WRITE_MODELS before touching anything
      const preview = await runMutation(action, { id: ids[0], [model]: data }, `success ${ERRORS_SELECTION}`, true);
      if (preview.isError) return preview;

      if (dry_run) {
        return json({
          dryRun: true,
          message: `Would run ${action} on ${ids.length} record(s). Nothing was changed. Re-run without dry_run to apply.`,
          matched: ids.length,
          ids: ids.slice(0, 20),
          ...(ids.length > 20 ? { moreIds: ids.length - 20 } : {}),
          data,
        });
      }

      const failed: { id: string; error: string }[] = [];
      let updated = 0;
      const CONCURRENCY = 5;
      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        await Promise.all(ids.slice(i, i + CONCURRENCY).map(async (id) => {
          try {
            const r = await runMutation(action, { id, [model]: data }, `success ${ERRORS_SELECTION}`);
            if (r.isError) failed.push({ id, error: r.content[0].text });
            else updated++;
          } catch (err: any) {
            failed.push({ id, error: err?.message ?? String(err) });
          }
        }));
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ matched: ids.length, updated, failed: failed.length, ...(failed.length ? { failures: failed.slice(0, 20) } : {}) }, null, 2) }],
        ...(failed.length ? { isError: updated === 0 } : {}),
      };
    }

    default:
      return null;
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
export const DATA_READ_TOOL_DEFINITIONS = [
  {
    name: "export_records",
    description:
      "Export many records (beyond query_records' 50) to a CSV or JSON file on this machine for analysis or sharing. Pages through automatically. Returns the file path, row count, columns and a short preview. Redaction settings apply.",
    inputSchema: {
      type: "object",
      required: ["model"],
      properties: {
        model: { type: "string", description: "Model name in singular camelCase, e.g. shopifyOrder" },
        fields: { type: "string", description: "Field selection (default: all scalar fields). Nested fields become dot-named CSV columns, e.g. \"* customer { email }\" → customer.email" },
        filter: { description: "Filter value — use introspect_filters for valid shapes" },
        sort: { description: "Sort value, e.g. [{ createdAt: { sortOrder: \"Descending\" } }]" },
        format: { type: "string", enum: ["csv", "json"], description: "File format (default csv)" },
        max_records: { type: "number", description: `Maximum records to export (default 10000, max ${EXPORT_MAX})` },
        filename: { type: "string", description: "Optional file name (no directories); saved in the export folder (GADGET_EXPORT_DIR or ~/gadget-mcp-exports)" },
      },
    },
  },
  {
    name: "group_count",
    description:
      "Count records grouped by a field's value, e.g. orders by financialStatus or products by vendor. Exact for enum and boolean fields; other fields are counted by scanning (up to max_records) and say whether the result is exact.",
    inputSchema: {
      type: "object",
      required: ["model", "field"],
      properties: {
        model: { type: "string", description: "Model name in singular camelCase, e.g. shopifyOrder" },
        field: { type: "string", description: "Scalar or enum field to group by, e.g. financialStatus" },
        filter: { description: "Optional filter applied before grouping" },
        max_records: { type: "number", description: `For non-enum fields: records to scan (default 10000, max ${GROUP_SCAN_MAX})` },
        top: { type: "number", description: "For non-enum fields: how many groups to return, largest first (default 50)" },
      },
    },
  },
];

export const DATA_WRITE_TOOL_DEFINITIONS = [
  {
    name: "bulk_update",
    description:
      `Update every record matching a filter with the same values by running the model's update action on each. Always run with dry_run: true first to see how many records match. Refuses if the filter matches more than max_records (default 100, max ${BULK_MAX}). Enabled by GADGET_ALLOW_WRITES.`,
    inputSchema: {
      type: "object",
      required: ["model", "filter", "data"],
      properties: {
        model: { type: "string", description: "Model name in singular camelCase, e.g. label" },
        filter: { description: "Which records to update — use introspect_filters for valid shapes" },
        data: { type: "object", description: "Field values to set on each matching record" },
        max_records: { type: "number", description: `Safety cap: refuse if more records match (default 100, max ${BULK_MAX})` },
        dry_run: { type: "boolean", description: "Count matching records and validate the update without changing anything" },
      },
    },
  },
];

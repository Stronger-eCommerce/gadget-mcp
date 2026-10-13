---
name: gadget
description: How to work with a Gadget app through the gadget MCP tools — exploring the schema, querying and counting records, exporting data, reading logs, and making safe changes. Use when the user asks about data, errors or records in their Gadget app (anything on <app>.gadget.app), or wants to look something up, fix a record, or export data.
---

# Working with a Gadget app

The `gadget` MCP server talks to one Gadget app's GraphQL API. Model names are singular camelCase (`shopifyOrder`, `label`).

## Finding your way around
- Unsure what exists? `get_schema_overview` (everything at once) or `list_models` → `introspect_model`.
- Filters: call `introspect_filters` before writing a non-trivial filter. Shapes look like `{ financialStatus: { equals: "paid" } }`, `{ createdAt: { greaterThan: "2026-01-01T00:00:00Z" } }`, `{ email: { isSet: false } }`. A list of filters means AND.

## Reading data
- `query_records` returns all scalar fields by default; add relations with `"* customer { email }"`. Max 50 per page; follow `endCursor` with `after`.
- "How many…?" → `count_records`. "…by status/vendor/etc.?" → `group_count` (exact for enums/booleans).
- More than a page of records, or the user wants a file → `export_records` (CSV/JSON) and tell them the path.
- `run_graphql` for nested/custom queries `query_records` can't express (read-only).

## Debugging
- `read_logs` with `level: "error"`, a `since` window and `search` set to a record ID or action name. If it says ggt isn't logged in, ask the user to run `npx ggt login` once.
- Prompts `debug_record`, `audit_errors`, `data_health` and `explore_app` are ready-made workflows.

## Changing data (only if write tools are listed)
1. Look first: fetch the record(s) you'll change.
2. Preview: run the write with `dry_run: true` and show the user what will happen (for `bulk_update`, the match count).
3. Ask before applying anything that touches more than one record, deletes, or runs an action with side effects.
4. Apply, then re-read to confirm.

Writes run the app's real actions (validations and side effects included). `GADGET_WRITE_MODELS` may restrict which models can change; the tool descriptions say which.

## Privacy
Fields shown as `[REDACTED]` are hidden on purpose by the server's settings. Don't try to work around it (aliases are refused). You can still filter by those fields.

## Something broken in the MCP server itself?
Use `report_bug` to give the user a pre-filled GitHub issue link.

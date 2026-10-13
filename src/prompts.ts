/**
 * MCP prompts: ready-made starting points that show up in the client's prompt picker
 * (e.g. as slash commands in Claude Code).
 */

interface PromptArg { name: string; description: string; required?: boolean }
interface PromptDef { name: string; title: string; description: string; arguments: PromptArg[]; build: (a: Record<string, string>) => string }

const PROMPTS: PromptDef[] = [
  {
    name: "explore_app",
    title: "Explore this Gadget app",
    description: "Get a plain-English overview of the app's models, how they relate, and how much data each holds.",
    arguments: [],
    build: () => `Give me an overview of this Gadget app.

1. Call get_schema_overview to see every model and its fields.
2. For the 10 most important-looking models, call count_records to see how much data each holds.
3. Summarise: what the app seems to do, the main models and how they relate (belongs-to / has-many), and anything notable (empty models, very large ones, status/enum fields worth knowing about).

Keep it short and skimmable.`,
  },
  {
    name: "debug_record",
    title: "Debug a record",
    description: "Investigate why a specific record looks wrong or an action on it failed.",
    arguments: [
      { name: "model", description: "Model name, e.g. shopifyOrder", required: true },
      { name: "id", description: "Record ID", required: true },
      { name: "problem", description: "What's wrong, in your words (optional)" },
    ],
    build: (a) => `Help me debug ${a.model} ${a.id}.${a.problem ? ` The problem: ${a.problem}` : ""}

1. get_record with fields "*" plus its most relevant relations.
2. read_logs with search "${a.id}" and since "1d" (then "7d" if nothing) to find related errors or action runs.
3. If useful, look at related records and compare with a similar record that looks healthy.
4. Explain the most likely cause, the evidence for it, and the fix. If a data fix is needed and write tools are enabled, show it with dry_run first and ask before applying it.`,
  },
  {
    name: "audit_errors",
    title: "Audit recent errors",
    description: "Find and group recent errors in the app logs, with likely causes.",
    arguments: [{ name: "since", description: "How far back, e.g. 1h, 1d (default 1d)" }],
    build: (a) => `Audit the errors in this Gadget app over the last ${a.since || "1d"}.

1. read_logs with level "error" and since "${a.since || "1d"}" (raise limit if there are many).
2. Group the errors by type/message and count them; note the first and last time each appeared.
3. For the top groups, look up the affected records if IDs appear in the logs.
4. Report a short table (error, count, last seen, likely cause) and suggest what to fix first.`,
  },
  {
    name: "data_health",
    title: "Data health check",
    description: "Check a model for missing values, odd statuses and other data-quality issues.",
    arguments: [{ name: "model", description: "Model name, e.g. shopifyProduct", required: true }],
    build: (a) => `Run a data health check on ${a.model}.

1. introspect_model to see its fields; count_records for the total.
2. group_count on its enum/status-like fields to see the distribution.
3. For important fields that should always be set, count_records with an isSet: false filter to find gaps.
4. Pull a few example records for anything that looks off.
5. Summarise issues by severity with counts, and suggest fixes. Don't change any data.`,
  },
];

export function listPrompts() {
  return PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args }));
}

export function getPrompt(name: string, args: Record<string, string> = {}) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) throw new Error(`Unknown prompt: ${name}`);
  const missing = p.arguments.filter((a) => a.required && !args[a.name]?.trim()).map((a) => a.name);
  if (missing.length) throw new Error(`Missing required argument(s) for ${name}: ${missing.join(", ")}`);
  return {
    description: p.description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text: p.build(args) } }],
  };
}

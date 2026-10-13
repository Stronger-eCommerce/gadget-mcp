/**
 * read_logs: fetch recent Gadget app logs through the ggt CLI (`ggt logs --json`).
 * ggt uses its own login (`ggt login`), separate from GADGET_API_KEY.
 */
import { execFile } from "child_process";
import { redactRecords } from "./tools.js";
import { redact } from "./report.js";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
const MAX_LINES = 500;

/** Parse "15m", "2h", "1d" or an ISO timestamp into an ISO timestamp. */
export function parseStart(input: string | undefined, now = Date.now()): string | null {
  if (!input) return new Date(now - 15 * 60_000).toISOString();
  const rel = /^(\d+)\s*(m|min|h|hr|d)$/i.exec(input.trim());
  if (rel) {
    const unit = rel[2].toLowerCase().startsWith("m") ? 60_000 : rel[2].toLowerCase().startsWith("h") ? 3_600_000 : 86_400_000;
    return new Date(now - Number(rel[1]) * unit).toISOString();
  }
  const t = Date.parse(input);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** The ggt command to run: GADGET_GGT_COMMAND (e.g. "ggt") or npx ggt@latest. */
function ggtCommand(): { cmd: string; prefix: string[] } {
  const custom = process.env.GADGET_GGT_COMMAND?.trim();
  if (custom) return { cmd: custom, prefix: [] };
  return { cmd: process.platform === "win32" ? "npx.cmd" : "npx", prefix: ["-y", "ggt@latest"] };
}

/** Overridable in tests */
export const _exec = {
  run: (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
    new Promise((resolve) => {
      // Windows needs a shell to run npx.cmd; every argument is validated (slug, ISO time, enum level)
      execFile(cmd, args, { timeout: 90_000, maxBuffer: 50 * 1024 * 1024, shell: process.platform === "win32" }, (err, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: err ? (typeof err.code === "number" ? err.code : 1) : 0 });
      });
    }),
};

export async function handleLogsTool(name: string, args: Record<string, any>): Promise<ToolResult | null> {
  if (name !== "read_logs") return null;

  const start = parseStart(args.since);
  if (!start) return { content: [{ type: "text", text: `Couldn't read since="${args.since}". Use e.g. "15m", "2h", "1d" or an ISO timestamp.` }], isError: true };
  const level = (args.level ?? "info").toLowerCase();
  if (!LEVELS.includes(level)) return { content: [{ type: "text", text: `level must be one of: ${LEVELS.join(", ")}` }], isError: true };
  const limit = Math.min(Math.max(1, args.limit ?? 100), MAX_LINES);

  const app = process.env.GADGET_APP!;
  const env = process.env.GADGET_ENVIRONMENT || "production";
  const { cmd, prefix } = ggtCommand();
  const cliArgs = [...prefix, "logs", "--app", app, "--env", env, "--start", start, "--log-level", level, "--json", ...(args.my_logs ? ["--my-logs"] : [])];

  const { stdout, stderr, code } = await _exec.run(cmd, cliArgs);
  if (code !== 0) {
    const msg = (stderr || stdout).trim();
    const needsLogin = /log(ged)? ?in|sign(ed)? ?in|unauthori[sz]ed|authenticat/i.test(msg);
    return {
      content: [{
        type: "text",
        text: needsLogin
          ? `ggt isn't logged in. Ask the user to run \`npx ggt login\` once in a terminal, then try again.\n\n${redact(msg).slice(0, 500)}`
          : `ggt logs failed (exit ${code}): ${redact(msg).slice(0, 1000) || "no output"}`,
      }],
      isError: true,
    };
  }

  // ggt --json prints one JSON object per line; keep anything else as plain text
  let entries: unknown[] = stdout.split("\n").filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return l; }
  });
  if (args.search) {
    const needle = String(args.search).toLowerCase();
    entries = entries.filter((e) => (typeof e === "string" ? e : JSON.stringify(e)).toLowerCase().includes(needle));
  }
  const total = entries.length;
  const shown = (redactRecords(entries.slice(-limit)) as unknown[])
    .map((e) => (typeof e === "string" ? redact(e) : JSON.parse(redact(JSON.stringify(e)))));

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        app, environment: env, since: start, level,
        matched: total,
        ...(total > shown.length ? { note: `Showing the latest ${shown.length} of ${total}. Narrow with since, level or search, or raise limit (max ${MAX_LINES}).` } : {}),
        logs: shown,
      }, null, 2),
    }],
  };
}

export const LOGS_TOOL_DEFINITIONS = [
  {
    name: "read_logs",
    description:
      "Read recent logs from the Gadget app (via the ggt CLI) to debug errors, failed actions or webhooks. Defaults to the last 15 minutes at info level. Needs a one-time `npx ggt login` on this machine.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "How far back: \"15m\", \"2h\", \"1d\", or an ISO timestamp (default 15m)" },
        level: { type: "string", enum: [...LEVELS], description: "Minimum level (default info); use \"error\" to find failures" },
        search: { type: "string", description: "Only return log lines containing this text (case-insensitive), e.g. a record ID or action name" },
        my_logs: { type: "boolean", description: "Only logs from the app's own code, hiding platform logs" },
        limit: { type: "number", description: `Max log lines to return, newest last (default 100, max ${MAX_LINES})` },
      },
    },
  },
];

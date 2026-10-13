import { platform, arch, release } from "os";
import { spawn } from "child_process";
import { currentVersion } from "./update.js";

export const ISSUES_URL = "https://github.com/Stronger-eCommerce/gadget-mcp/issues/new";

// GitHub rejects very long URLs; keep well under the ~8KB limit.
const MAX_URL_LENGTH = 7500;

export interface BugReport {
  title?: string;
  whatHappened?: string;
  expected?: string;
  steps?: string;
  logs?: string;
}

// ── Client info (set by the MCP server once the client connects) ─────────────
let clientInfo: { name?: string; version?: string } | undefined;
export function setClientInfo(info: { name?: string; version?: string } | undefined): void {
  clientInfo = info;
}

/** Strip API keys and bearer tokens so they can never end up in a public issue. */
export function redact(text: string): string {
  let out = text
    .replace(/gsk-[A-Za-z0-9_\-]+/g, "gsk-[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[REDACTED]");
  const key = process.env.GADGET_API_KEY;
  if (key && key.length >= 8) out = out.split(key).join("[REDACTED]");
  return out;
}

/** Environment details for a bug report. Never includes the API key or app slug. */
export function diagnostics(extra: Record<string, string> = {}): string {
  const on = (name: string) => (process.env[name] ? "on" : "off");
  const lines: Record<string, string> = {
    "gadget-mcp": currentVersion(),
    node: process.version,
    os: `${platform()} ${arch()} (${release()})`,
    ...(clientInfo?.name ? { client: `${clientInfo.name}${clientInfo.version ? ` ${clientInfo.version}` : ""}` } : {}),
    environment: process.env.GADGET_ENVIRONMENT ?? "production",
    writes: on("GADGET_ALLOW_WRITES"),
    deletes: on("GADGET_ALLOW_DELETES"),
    "audit log": on("GADGET_AUDIT_LOG"),
    "write allowlist": on("GADGET_WRITE_MODELS"),
    redaction: on("GADGET_REDACT_FIELDS"),
    ...extra,
  };
  return Object.entries(lines).map(([k, v]) => `${k}: ${v}`).join("\n");
}

/** Build a GitHub "new issue" URL that pre-fills the bug report form. */
export function buildIssueUrl(report: BugReport, diag = diagnostics()): string {
  const fields: [string, string | undefined][] = [
    ["what-happened", report.whatHappened],
    ["expected", report.expected],
    ["steps", report.steps],
    ["diagnostics", diag],
    ["logs", report.logs], // last, so it's the one trimmed when the URL is too long
  ];

  const build = (logs?: string) => {
    const params = new URLSearchParams({ template: "bug_report.yml" });
    if (report.title) params.set("title", redact(`[Bug]: ${report.title}`));
    for (const [id, value] of fields) {
      const v = id === "logs" ? logs : value;
      if (v?.trim()) params.set(id, redact(v.trim()));
    }
    return `${ISSUES_URL}?${params.toString()}`;
  };

  const logs = report.logs;
  let url = build(logs);
  if (url.length > MAX_URL_LENGTH && logs) {
    // Binary-search the longest prefix of the error output that still fits
    let lo = 0, hi = logs.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (build(`${logs.slice(0, mid)}\n… (truncated)`).length <= MAX_URL_LENGTH) lo = mid;
      else hi = mid - 1;
    }
    url = build(`${logs.slice(0, lo)}\n… (truncated)`);
  }
  return url;
}

/** Best-effort: open a URL in the default browser. Returns false if it couldn't. */
export function openInBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      platform() === "darwin" ? ["open", [url]] :
      // rundll32 takes the URL verbatim; `cmd /c start` would split it at every "&"
      platform() === "win32"  ? ["rundll32", ["url.dll,FileProtocolHandler", url]] :
                                ["xdg-open", [url]];
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

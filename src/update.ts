import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { createRequire } from "module";

export const PKG_NAME = "@stronger-ecommerce/gadget-mcp";
export const RELEASES_URL = "https://github.com/Stronger-eCommerce/gadget-mcp/releases";
export const UPGRADE_CMD = `npx ${PKG_NAME}@latest upgrade`;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  gray:   "\x1b[90m",
};

// ── Version helpers ───────────────────────────────────────────────────────────
export function currentVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return (req("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

/** Compare two semver strings. Returns >0 if a is newer, <0 if b is newer, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // 1.2.0 is newer than 1.2.0-beta.1
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  return (pa.pre ?? "").localeCompare(pb.pre ?? "");
}

export type UpdateKind = "major" | "minor" | "patch";

export interface UpdateInfo {
  current: string;
  latest: string;
  kind: UpdateKind;
}

function updateKind(current: string, latest: string): UpdateKind {
  const [cMaj, cMin] = current.split(".").map((n) => parseInt(n, 10) || 0);
  const [lMaj, lMin] = latest.split(".").map((n) => parseInt(n, 10) || 0);
  if (lMaj !== cMaj) return "major";
  if (lMin !== cMin) return "minor";
  return "patch";
}

// ── Registry check (cached for 24h) ───────────────────────────────────────────
function defaultCacheFile(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "gadget-mcp", "update-check.json");
}

interface CheckOptions {
  /** Skip the cache and always hit the registry */
  force?: boolean;
  cacheFile?: string;
  now?: number;
  current?: string;
}

async function fetchLatest(): Promise<string | null> {
  const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return null;
  const { version } = await res.json() as { version: string };
  return version ?? null;
}

/** Returns update details when a newer version is published, otherwise null. Never throws. */
export async function getUpdateInfo(opts: CheckOptions = {}): Promise<UpdateInfo | null> {
  if (process.env.GADGET_MCP_NO_UPDATE_CHECK) return null;
  const cacheFile = opts.cacheFile ?? defaultCacheFile();
  const now = opts.now ?? Date.now();
  const current = opts.current ?? currentVersion();

  try {
    let latest: string | null = null;

    if (!opts.force) {
      try {
        const cached = JSON.parse(readFileSync(cacheFile, "utf8")) as { checkedAt: number; latest: string };
        if (now - cached.checkedAt < CHECK_INTERVAL_MS) latest = cached.latest;
      } catch {
        // no cache yet
      }
    }

    if (!latest) {
      latest = await fetchLatest();
      if (!latest) return null;
      try {
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, JSON.stringify({ checkedAt: now, latest }), "utf8");
      } catch {
        // read-only home dir — fine, we just check again next time
      }
    }

    if (compareVersions(latest, current) <= 0) return null;
    return { current, latest, kind: updateKind(current, latest) };
  } catch {
    return null; // network unavailable — silently skip
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Draw a rounded box around lines, padding by visible width (ANSI-aware). */
export function box(lines: string[], color = c.yellow): string {
  const width = Math.max(...lines.map((l) => stripAnsi(l).length)) + 4;
  const top = `${color}╭${"─".repeat(width)}╮${c.reset}`;
  const bottom = `${color}╰${"─".repeat(width)}╯${c.reset}`;
  const row = (l: string) =>
    `${color}│${c.reset}  ${l}${" ".repeat(width - 2 - stripAnsi(l).length)}${color}│${c.reset}`;
  return [top, row(""), ...lines.map(row), row(""), bottom].join("\n");
}

export function renderUpdateBox(info: UpdateInfo): string {
  const kindLabel = {
    major: `${c.red}${c.bold}major${c.reset} ${c.dim}— may include breaking changes${c.reset}`,
    minor: `${c.green}minor${c.reset} ${c.dim}— new features${c.reset}`,
    patch: `${c.cyan}patch${c.reset} ${c.dim}— fixes${c.reset}`,
  }[info.kind];

  return box([
    `${c.bold}⬆  Gadget MCP update available${c.reset}   ${c.dim}${info.current}${c.reset} → ${c.green}${c.bold}${info.latest}${c.reset}`,
    `   ${kindLabel}`,
    "",
    `   Upgrade:     ${c.cyan}${UPGRADE_CMD}${c.reset}`,
    `   What's new:  ${c.cyan}${RELEASES_URL}${c.reset}`,
  ]);
}

/** Plain-text notice appended to a tool result so the agent can relay it to the user. */
export function updateNoticeForAgent(info: UpdateInfo): string {
  return (
    `[gadget-mcp] A ${info.kind} update is available: ${info.current} → ${info.latest}. ` +
    `Mention this to the user once: they can upgrade with \`${UPGRADE_CMD}\` and restart their editor. ` +
    `Release notes: ${RELEASES_URL}`
  );
}

/** Check for an update and print a boxed prompt to stderr (stdout is the MCP channel). */
export async function checkForUpdate(opts: CheckOptions = {}): Promise<UpdateInfo | null> {
  const info = await getUpdateInfo(opts);
  if (info) {
    console.error();
    console.error(renderUpdateBox(info));
    console.error();
  }
  return info;
}

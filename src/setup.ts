import { readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { createInterface } from "readline";
import { join, dirname } from "path";
import { homedir } from "os";
import { createRequire } from "module";
import { execSync } from "child_process";

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  blue:   "\x1b[34m",
  gray:   "\x1b[90m",
  white:  "\x1b[97m",
};

const fmt = {
  header:  (s: string) => `${c.bold}${c.cyan}${s}${c.reset}`,
  success: (s: string) => `${c.green}✔${c.reset}  ${s}`,
  info:    (s: string) => `${c.blue}ℹ${c.reset}  ${s}`,
  warn:    (s: string) => `${c.yellow}⚠${c.reset}  ${s}`,
  error:   (s: string) => `${c.red}✖${c.reset}  ${s}`,
  label:   (s: string) => `${c.bold}${c.white}${s}${c.reset}`,
  dim:     (s: string) => `${c.dim}${s}${c.reset}`,
  code:    (s: string) => `${c.cyan}${s}${c.reset}`,
  section: (title: string, width = 60) => {
    const line = "─".repeat(width);
    return `${c.gray}${line}${c.reset}\n${c.bold} ${title}${c.reset}\n${c.gray}${line}${c.reset}`;
  },
};

// ── Version check ─────────────────────────────────────────────────────────────
const PKG_NAME = "@stronger-ecommerce/gadget-mcp";

function currentVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return (req("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

export async function checkForUpdate(): Promise<void> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const { version: latest } = await res.json() as { version: string };
    const current = currentVersion();
    if (latest !== current) {
      const w = 60;
      const line = "─".repeat(w);
      console.error(`${c.yellow}${line}${c.reset}`);
      console.error(`${c.yellow}  Update available: ${c.bold}${current}${c.reset}${c.yellow} → ${c.bold}${latest}${c.reset}`);
      console.error(`${c.yellow}  Run: ${c.bold}npm i -g ${PKG_NAME}@latest${c.reset}${c.yellow}  or use npx for the latest${c.reset}`);
      console.error(`${c.yellow}${line}${c.reset}`);
      console.error();
    }
  } catch {
    // network unavailable — silently skip
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
interface SyncJson {
  application: string;
  environment?: string;
}

function findSyncJson(dir: string): string | null {
  const candidate = join(dir, ".gadget", "sync.json");
  if (existsSync(candidate)) return candidate;
  const parent = dirname(dir);
  if (parent === dir) return null;
  return findSyncJson(parent);
}

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function mask(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "····" + key.slice(-4);
}

async function testConnection(app: string, env: string, apiKey: string): Promise<{ ok: boolean; models?: number; error?: string }> {
  const url = env === "development"
    ? `https://${app}--development.gadget.app/api/graphql`
    : `https://${app}.gadget.app/api/graphql`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query: "{ __schema { queryType { fields { name } } } }" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const json = await res.json() as any;
    if (json.errors?.length) return { ok: false, error: json.errors[0].message };
    const count = json.data?.__schema?.queryType?.fields?.length ?? 0;
    return { ok: true, models: count };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

// ── Tool installers ───────────────────────────────────────────────────────────
interface McpEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function mcpEntry(appSlug: string, apiKey: string, environment: string): McpEntry {
  return {
    command: "npx",
    args: ["@stronger-ecommerce/gadget-mcp"],
    env: {
      GADGET_APP: appSlug,
      GADGET_API_KEY: apiKey,
      ...(environment !== "production" ? { GADGET_ENVIRONMENT: environment } : {}),
    },
  };
}

function writeJsonMcpConfig(filePath: string, serverName: string, entry: McpEntry): void {
  let existing: Record<string, any> = { mcpServers: {} };
  if (existsSync(filePath)) {
    try {
      existing = JSON.parse(readFileSync(filePath, "utf8"));
      existing.mcpServers = existing.mcpServers ?? {};
    } catch {
      existing = { mcpServers: {} };
    }
  } else {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  existing.mcpServers[serverName] = entry;
  writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf8");
}

type Scope = "global" | "project";

interface Tool {
  label: string;
  key: string;
  install: (serverName: string, entry: McpEntry, appSlug: string, environment: string, apiKey: string, scope: Scope, projectRoot: string | null) => string | null;
}

const TOOLS: Tool[] = [
  {
    label: "Claude Code (CLI)",
    key: "claude-code",
    install: (serverName, entry, appSlug, environment, apiKey, scope) => {
      const envFlags = [
        `-e GADGET_APP=${appSlug}`,
        ...(environment !== "production" ? [`-e GADGET_ENVIRONMENT=${environment}`] : []),
        `-e GADGET_API_KEY=${apiKey}`,
      ].join(" ");
      const scopeFlag = scope === "project" ? " -s project" : "";
      const cmd = `claude mcp add${scopeFlag} ${serverName} ${envFlags} -- npx @stronger-ecommerce/gadget-mcp`;
      try {
        execSync(cmd, { stdio: "pipe" });
        return null; // success
      } catch (err: any) {
        const msg = err?.stderr?.toString()?.trim() || err?.message;
        return msg || "unknown error";
      }
    },
  },
  {
    label: "Cursor",
    key: "cursor",
    install: (serverName, entry, appSlug, environment, apiKey, scope, projectRoot) => {
      try {
        const configPath = scope === "project" && projectRoot
          ? join(projectRoot, ".cursor", "mcp.json")
          : join(homedir(), ".cursor", "mcp.json");
        writeJsonMcpConfig(configPath, serverName, entry);
        return null;
      } catch (err: any) { return err?.message; }
    },
  },
  {
    label: "VS Code",
    key: "vscode",
    install: (serverName, entry, appSlug, environment, apiKey, scope, projectRoot) => {
      try {
        const configPath = scope === "project" && projectRoot
          ? join(projectRoot, ".vscode", "mcp.json")
          : join(homedir(), ".vscode", "mcp.json");
        writeJsonMcpConfig(configPath, serverName, entry);
        return null;
      } catch (err: any) { return err?.message; }
    },
  },
  {
    label: "Windsurf",
    key: "windsurf",
    install: (serverName, entry) => {
      try {
        writeJsonMcpConfig(join(homedir(), ".codeium", "windsurf", "mcp_config.json"), serverName, entry);
        return null;
      } catch (err: any) { return err?.message; }
    },
  },
];

function apiKeysUrl(app: string, env: string): string {
  return `https://${app}.gadget.app/edit/${env}/settings/api-keys`;
}

function permissionsUrl(app: string, env: string): string {
  return `https://${app}.gadget.app/edit/${env}/settings/permissions`;
}

const MCP_ROLE = "gadget-mcp-read";

function permissionsFilePath(syncPath: string): string | null {
  try {
    const projectRoot = dirname(dirname(syncPath));
    const p = join(projectRoot, "accessControl", "permissions.gadget.ts");
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

// Get all model names from api/models/ directory (most complete source of truth)
// Falls back to parsing permissions.gadget.ts if the directory doesn't exist
function extractModels(permFile: string): string[] {
  try {
    const projectRoot = dirname(dirname(permFile)); // up from accessControl/
    const modelsDir = join(projectRoot, "api", "models");
    if (existsSync(modelsDir)) {
      return readdirSync(modelsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
    }
  } catch {
    // fall through to permissions-based extraction
  }

  // Fallback: parse model names already referenced in permissions.gadget.ts
  const content = readFileSync(permFile, "utf8");
  const models = new Set<string>();
  const modelsBlockRe = /models:\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = modelsBlockRe.exec(content)) !== null) {
    const open = content.indexOf("{", m.index);
    let depth = 0, i = open, close = open;
    for (; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") { depth--; if (depth === 0) { close = i; break; } }
    }
    const block = content.slice(open + 1, close);
    let d = 0, j = 0;
    while (j < block.length) {
      const ch = block[j];
      if (ch === "{") { d++; j++; continue; }
      if (ch === "}") { d--; j++; continue; }
      if (d === 0) {
        const km = block.slice(j).match(/^([a-z][a-zA-Z0-9]*)\s*:/);
        if (km) { models.add(km[1]); j += km[0].length; continue; }
      }
      j++;
    }
  }
  return [...models].sort();
}

function buildRoleEntry(roleName: string, models: string[]): string {
  const pad = "    ";
  const modelLines = models
    .map(m => `${pad}    ${m}: {\n${pad}      read: true,\n${pad}    },`)
    .join("\n");
  return [
    `${pad}"${roleName}": {`,
    `${pad}  storageKey: "Role-${roleName}",`,
    `${pad}  models: {`,
    modelLines,
    `${pad}  },`,
    `${pad}},`,
  ].join("\n");
}

function injectRole(content: string, roleName: string, models: string[]): string {
  const rolesIdx = content.indexOf("roles: {");
  if (rolesIdx === -1) throw new Error("Could not find roles: { in permissions file");
  const open = content.indexOf("{", rolesIdx);
  let depth = 0, i = open, closing = -1;
  for (; i < content.length; i++) {
    if (content[i] === "{") depth++;
    else if (content[i] === "}") { depth--; if (depth === 0) { closing = i; break; } }
  }
  if (closing === -1) throw new Error("Could not find closing brace of roles");
  const entry = buildRoleEntry(roleName, models);
  return content.slice(0, closing) + entry + "\n  " + content.slice(closing);
}

function roleExistsInContent(content: string, roleName: string): boolean {
  return content.includes(`"${roleName}"`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
export async function runSetup(): Promise<void> {
  await checkForUpdate();

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log();
  console.log(fmt.header("  ◆ Gadget MCP Setup"));
  console.log(fmt.dim("  Connect any Gadget app to Claude Code or Cursor"));
  console.log(fmt.dim("  by Stronger eCommerce · strongerecommerce.com"));
  console.log();

  // 1. Auto-detect app from .gadget/sync.json
  let appSlug = "";
  let environment = "production";

  const syncPath = findSyncJson(process.cwd());
  if (syncPath) {
    try {
      const sync: SyncJson = JSON.parse(readFileSync(syncPath, "utf8"));
      appSlug = sync.application ?? "";
      console.log(fmt.success(`Detected Gadget app ${fmt.label(appSlug)}`));
      console.log(fmt.dim(`           from ${syncPath}`));
    } catch {
      console.log(fmt.warn(`Found ${syncPath} but couldn't parse it.`));
    }
  } else {
    console.log(fmt.info("No .gadget/sync.json found — you can enter the app slug manually."));
  }
  console.log();

  // 2. Confirm or enter app slug
  const appInput = await prompt(
    rl,
    appSlug
      ? `  ${fmt.label("App slug")} ${c.dim}[${appSlug}]${c.reset}: `
      : `  ${fmt.label("App slug")} ${c.dim}(e.g. my-app)${c.reset}: `
  );
  if (appInput.trim()) appSlug = appInput.trim();

  if (!appSlug) {
    console.log("\n" + fmt.error("App slug is required."));
    rl.close();
    process.exit(1);
  }

  // 3. Environment
  const envInput = await prompt(rl, `  ${fmt.label("Environment")} ${c.dim}[production]${c.reset}: `);
  if (envInput.trim()) environment = envInput.trim();

  // 4. Role setup
  console.log();
  const permFile = syncPath ? permissionsFilePath(syncPath) : null;
  let roleToUse = MCP_ROLE;

  if (!permFile) {
    // No local permissions file — fall back to manual instructions
    console.log(fmt.info("No local permissions.gadget.ts found."));
    console.log(fmt.info(`Create a read-only role manually at: ${c.cyan}${permissionsUrl(appSlug, "development")}${c.reset}`));
    console.log();
    const roleInput = await prompt(
      rl,
      `  Role name ${c.dim}[${MCP_ROLE}]${c.reset} ${c.dim}(or type an existing role to use)${c.reset}: `
    );
    roleToUse = roleInput.trim() || MCP_ROLE;
    console.log();
  } else {
    const permContent = readFileSync(permFile, "utf8");

    if (roleExistsInContent(permContent, MCP_ROLE)) {
      console.log(fmt.success(`Role ${fmt.label(MCP_ROLE)} already exists in permissions.gadget.ts`));
    } else {
      console.log(fmt.warn(`Role ${fmt.label(MCP_ROLE)} not found in permissions.gadget.ts`));
      console.log();

      const roleInput = await prompt(
        rl,
        `  Role name ${c.dim}[${MCP_ROLE}]${c.reset} ${c.dim}(Enter to create, or type an existing role name to skip)${c.reset}: `
      );
      roleToUse = roleInput.trim() || MCP_ROLE;

      if (roleExistsInContent(permContent, roleToUse)) {
        console.log();
        console.log(fmt.success(`Using existing role ${fmt.label(roleToUse)}`));
      } else {
        // Auto-write the role into permissions.gadget.ts
        const models = extractModels(permFile);
        console.log();
        console.log(fmt.info(`Found ${models.length} models: ${c.dim}${models.slice(0, 6).join(", ")}${models.length > 6 ? ` +${models.length - 6} more` : ""}${c.reset}`));

        const confirmInput = await prompt(
          rl,
          `  Add role ${c.bold}${c.white}${roleToUse}${c.reset} with ${c.bold}read: true${c.reset} for all ${models.length} models? ${c.dim}[Y/n]${c.reset}: `
        );

        if (confirmInput.trim().toLowerCase() !== "n") {
          try {
            const updated = injectRole(permContent, roleToUse, models);
            writeFileSync(permFile, updated, "utf8");
            console.log();
            console.log(fmt.success(`Written to ${permFile}`));
            console.log();
            console.log(fmt.section("  ⚠  Deploy before continuing"));
            console.log();
            console.log(`  The role was added to your local file but is ${c.bold}not live yet${c.reset}.`);
            console.log(`  You must deploy to ${c.bold}development${c.reset} before creating an API key:`);
            console.log();
            console.log(fmt.code(`    ggt push`));
            console.log();
            console.log(`  Then verify the role appeared at:`);
            console.log(`  ${c.cyan}${permissionsUrl(appSlug, "development")}${c.reset}`);
            console.log();
            await prompt(rl, `  Press ${c.bold}Enter${c.reset} once deployed and ready to create the API key… `);
          } catch (err: any) {
            console.log();
            console.log(fmt.error(`Could not write file: ${err?.message ?? String(err)}`));
            console.log(fmt.info(`Create the role manually at: ${c.cyan}${permissionsUrl(appSlug, "development")}${c.reset}`));
          }
        } else {
          console.log();
          console.log(fmt.info(`Skipped. Create the role manually at: ${c.cyan}${permissionsUrl(appSlug, "development")}${c.reset}`));
        }
      }
    }
    console.log();
  }

  // 5. API key
  console.log(fmt.section("  Create the API key"));
  console.log();
  console.log(`  1. Open:  ${c.cyan}${apiKeysUrl(appSlug, environment)}${c.reset}`);
  console.log(`  2. Create a new key and assign the ${c.bold}${c.white}${roleToUse}${c.reset} role to it.`);
  console.log();
  const apiKey = await prompt(rl, `  ${fmt.label("Paste API key")}: `);
  if (!apiKey.trim()) {
    console.log("\n" + fmt.error("API key is required."));
    rl.close();
    process.exit(1);
  }
  const trimmedKey = apiKey.trim();

  // 5. Server name
  const defaultName = `${appSlug}-gadget`;
  const nameInput = await prompt(rl, `  ${fmt.label("MCP server name")} ${c.dim}[${defaultName}]${c.reset}: `);
  const serverName = nameInput.trim() || defaultName;

  // ── Results ────────────────────────────────────────────────────────────────
  console.log();
  console.log(fmt.success(`Connected key for ${fmt.label(appSlug)} ${c.dim}(${mask(trimmedKey)})${c.reset}`));
  console.log();

  // ── Tool selection ────────────────────────────────────────────────────────
  console.log(fmt.section("  Install MCP server"));
  console.log();
  TOOLS.forEach((t, i) => console.log(`  ${c.bold}${i + 1}.${c.reset} ${t.label}`));
  console.log();
  const selInput = await prompt(
    rl,
    `  Which tools to configure? ${c.dim}[1-${TOOLS.length}, comma-separated, or Enter for all]${c.reset}: `
  );

  const indices: number[] = selInput.trim()
    ? selInput.split(",").map(s => parseInt(s.trim(), 10) - 1).filter(i => i >= 0 && i < TOOLS.length)
    : TOOLS.map((_, i) => i);

  const selected = indices.map(i => TOOLS[i]);

  // ── Scope selection ───────────────────────────────────────────────────────
  const projectRoot = syncPath ? dirname(dirname(syncPath)) : null;
  let scope: Scope = "global";

  if (projectRoot) {
    console.log();
    console.log(fmt.info(`Project root detected: ${c.dim}${projectRoot}${c.reset}`));
    const scopeInput = await prompt(
      rl,
      `  Install scope ${c.dim}[project/global, default: project]${c.reset}: `
    );
    scope = scopeInput.trim().toLowerCase() === "global" ? "global" : "project";
  } else {
    console.log();
    console.log(fmt.info("No project root detected — installing globally."));
  }

  rl.close();

  console.log();
  const entry = mcpEntry(appSlug, trimmedKey, environment);

  for (const tool of selected) {
    process.stdout.write(`  Installing for ${c.bold}${tool.label}${c.reset}… `);
    const err = tool.install(serverName, entry, appSlug, environment, trimmedKey, scope, projectRoot);
    if (err === null) {
      console.log(`${c.green}✔${c.reset}`);
    } else {
      console.log(`${c.red}✖${c.reset}  ${c.dim}${err}${c.reset}`);
    }
  }
  console.log();
  console.log(fmt.dim("  Restart your editor(s) to pick up the new MCP server."));
  console.log();

  // ── Connection test ───────────────────────────────────────────────────────
  console.log(fmt.section("  Testing connection"));
  console.log();
  process.stdout.write(`  Connecting to ${c.cyan}${appSlug}.gadget.app${c.reset}… `);
  const test = await testConnection(appSlug, environment, trimmedKey);
  if (test.ok) {
    console.log(`${c.green}✔${c.reset}`);
    console.log();
    console.log(fmt.success(`Connected! Found ${c.bold}${test.models}${c.reset} queryable fields.`));
    console.log(fmt.dim("           Your MCP server is ready to use."));
  } else {
    console.log(`${c.red}✖${c.reset}`);
    console.log();
    console.log(fmt.error(`Connection failed: ${test.error}`));
    console.log();
    console.log(`  Things to check:`);
    console.log(`  ${c.dim}·${c.reset} Did you deploy the role? ${c.cyan}ggt push${c.reset}`);
    console.log(`  ${c.dim}·${c.reset} Does the API key have the ${c.bold}${roleToUse}${c.reset} role assigned?`);
    console.log(`  ${c.dim}·${c.reset} Is the app slug correct? ${c.dim}(${appSlug})${c.reset}`);
    console.log(`  ${c.dim}·${c.reset} Check keys at: ${c.cyan}${apiKeysUrl(appSlug, environment)}${c.reset}`);
  }
  console.log();
}

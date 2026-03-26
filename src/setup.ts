import { readFileSync, existsSync, writeFileSync } from "fs";
import { createInterface } from "readline";
import { join, dirname } from "path";
import { homedir } from "os";

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
  return key.slice(0, 4) + "****" + key.slice(-4);
}

export async function runSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("\n🔧 Gadget MCP Setup\n");

  // 1. Auto-detect app from .gadget/sync.json
  let appSlug = "";
  let environment = "production";

  const syncPath = findSyncJson(process.cwd());
  if (syncPath) {
    try {
      const sync: SyncJson = JSON.parse(readFileSync(syncPath, "utf8"));
      appSlug = sync.application ?? "";
      console.log(`✅ Detected Gadget app: ${appSlug} (from ${syncPath})`);
    } catch {
      console.log(`⚠️  Found ${syncPath} but couldn't parse it.`);
    }
  } else {
    console.log("ℹ️  No .gadget/sync.json found in this directory tree.");
  }

  // 2. Confirm or enter app slug
  const appInput = await prompt(
    rl,
    appSlug
      ? `App slug [${appSlug}]: `
      : "App slug (e.g. my-app): "
  );
  if (appInput.trim()) appSlug = appInput.trim();

  if (!appSlug) {
    console.error("❌ App slug is required.");
    rl.close();
    process.exit(1);
  }

  // 3. Environment
  const envInput = await prompt(rl, `Environment [production]: `);
  if (envInput.trim()) environment = envInput.trim();

  // 4. API key
  console.log(
    `\nGet your API key at: https://${appSlug}.gadget.app/edit/settings/api-keys`
  );
  const apiKey = await prompt(rl, "API key: ");
  if (!apiKey.trim()) {
    console.error("❌ API key is required.");
    rl.close();
    process.exit(1);
  }
  const trimmedKey = apiKey.trim();

  // 5. Server name
  const defaultName = `${appSlug}-gadget`;
  const nameInput = await prompt(rl, `MCP server name [${defaultName}]: `);
  const serverName = nameInput.trim() || defaultName;

  rl.close();

  // 6. Output results
  console.log(`\n✅ Setup complete for ${appSlug} (${mask(trimmedKey)})\n`);

  const npxCmd = `npx @stronger-ecommerce/gadget-mcp`;

  console.log("── Claude Code ─────────────────────────────────────────────");
  console.log(`Run this command:\n`);
  console.log(
    `  claude mcp add ${serverName} \\\n` +
    `    -e GADGET_APP=${appSlug} \\\n` +
    (environment !== "production" ? `    -e GADGET_ENVIRONMENT=${environment} \\\n` : "") +
    `    -e GADGET_API_KEY=${trimmedKey} \\\n` +
    `    -- ${npxCmd}\n`
  );

  // 7. Offer to auto-write Cursor config
  const cursorConfig = join(homedir(), ".cursor", "mcp.json");
  console.log("── Cursor ──────────────────────────────────────────────────");

  let existing: Record<string, any> = { mcpServers: {} };
  if (existsSync(cursorConfig)) {
    try {
      existing = JSON.parse(readFileSync(cursorConfig, "utf8"));
      existing.mcpServers = existing.mcpServers ?? {};
    } catch {
      existing = { mcpServers: {} };
    }
  }

  const entry: Record<string, any> = {
    command: "npx",
    args: ["@stronger-ecommerce/gadget-mcp"],
    env: {
      GADGET_APP: appSlug,
      GADGET_API_KEY: trimmedKey,
      ...(environment !== "production" ? { GADGET_ENVIRONMENT: environment } : {}),
    },
  };

  existing.mcpServers[serverName] = entry;
  const configJson = JSON.stringify(existing, null, 2);

  if (existsSync(cursorConfig)) {
    console.log(`\nFound existing ${cursorConfig}.`);
    console.log(`Would add "${serverName}" to mcpServers. Preview:\n`);
  } else {
    console.log(`\nWould create ${cursorConfig}. Preview:\n`);
  }
  console.log(configJson);

  // We can't prompt after rl.close(), so just write it
  writeFileSync(cursorConfig, configJson, "utf8");
  console.log(`\n✅ Written to ${cursorConfig}`);
  console.log("\nRestart Cursor to pick up the new MCP server.");
  console.log("─────────────────────────────────────────────────────────\n");
}

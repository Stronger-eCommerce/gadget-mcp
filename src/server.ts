import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { handleTool, getToolDefinitions } from "./tools.js";
import { checkForUpdate, currentVersion, updateNoticeForAgent } from "./update.js";
import { setClientInfo } from "./report.js";
import { listPrompts, getPrompt } from "./prompts.js";

/** Exit early with a clear message when the required env vars are missing. */
export function requireConfig(): void {
  if (!process.env.GADGET_APP || !process.env.GADGET_API_KEY) {
    console.error("GADGET_APP and GADGET_API_KEY environment variables are required");
    process.exit(1);
  }
}

// Update notice for the agent — appended to the first tool result after an update is found,
// since stderr is rarely visible to users when the server runs inside an editor.
let pendingUpdateNotice: string | null = null;
let updateCheckStarted = false;

function startUpdateCheck(): void {
  if (updateCheckStarted) return;
  updateCheckStarted = true;
  // fire-and-forget; prints to stderr so MCP stdio is unaffected
  checkForUpdate().then((info) => {
    if (info) pendingUpdateNotice = updateNoticeForAgent(info);
  });
}

/** Build an MCP server with all tools and prompts registered. */
export function createServer(): Server {
  const server = new Server(
    { name: `${process.env.GADGET_APP}-gadget`, version: currentVersion() },
    { capabilities: { tools: {}, prompts: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolDefinitions() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await handleTool(name, (args ?? {}) as Record<string, any>);
    if (pendingUpdateNotice) {
      result.content.push({ type: "text", text: pendingUpdateNotice });
      pendingUpdateNotice = null;
    }
    return result;
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getPrompt(request.params.name, (request.params.arguments ?? {}) as Record<string, string>)
  );

  // Lets report_bug include which editor/client the user is on
  server.oninitialized = () => setClientInfo(server.getClientVersion());

  startUpdateCheck();
  return server;
}

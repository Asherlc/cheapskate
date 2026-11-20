import { chmodSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { Assignment } from "../shared/contracts";

export type Workspace = Omit<Assignment, "deviceId">;

/** What an agent can do: see the devices it may use, switch between its workspace's, take a free one. */
export interface Picker {
  list(workspace: Workspace): Promise<string>;
  use(workspace: Workspace, deviceId: string, agentId?: string): Promise<string>;
  listPreviews(workspace: Workspace, deviceId?: string): Promise<string>;
  openPreview(workspace: Workspace, previewId: string, deviceId?: string, agentId?: string): Promise<string>;
}

const TOOLS = [
  {
    name: "list_devices",
    description:
      "The simulators and emulators the user allowed agents to drive, whether each is on, and which workspace holds it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "use_device",
    description:
      "Makes the device tools drive a device from list_devices: one of this workspace's, or a free one, which joins this workspace (the user sees it in its Device panel). A simulator or emulator that is off is turned on.",
    inputSchema: {
      type: "object",
      properties: { deviceId: { type: "string", description: "An id from list_devices" } },
      required: ["deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_previews",
    description:
      "Lists the named SwiftUI previews configured in the workspace's paseo-previews.json and the launch status (building/opened/error) of the selected booted iOS simulator. A missing catalog returns setup guidance. After open_preview, call this and wait for the opened status before driving the preview with the device tools.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "Optional; defaults to the device the tools drive" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "open_preview",
    description:
      "Builds and launches a named SwiftUI preview on a booted iOS simulator assigned to this workspace, foregrounding the app. Requires an id from list_previews; an optional deviceId defaults to the device the tools drive. Returns immediately while the build runs: call list_previews and wait for opened before interacting. Agent tools must be allowed on the simulator.",
    inputSchema: {
      type: "object",
      properties: {
        previewId: { type: "string", description: "An id from list_previews" },
        deviceId: { type: "string", description: "Optional; defaults to the device the tools drive" },
      },
      required: ["previewId"],
      additionalProperties: false,
    },
  },
];

type Message = {
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: { deviceId?: unknown; previewId?: unknown } };
};

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The answer to one MCP message from an agent in `workspace`; null for a notification. */
export async function reply(message: Message, workspace: Workspace, picker: Picker, agentId?: string) {
  if (message.id === undefined) return null;
  const result = (value: object) => ({ jsonrpc: "2.0", id: message.id, result: value });
  switch (message.method) {
    case "initialize":
      return result({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "paseo-devices", version: "1.0.0" },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args } = message.params ?? {};
      try {
        let answer: string;
        const device = args?.deviceId ? String(args.deviceId) : undefined;
        if (name === "list_devices") answer = await picker.list(workspace);
        else if (name === "use_device") answer = await picker.use(workspace, device ?? "", agentId);
        else if (name === "list_previews") answer = await picker.listPreviews(workspace, device);
        else if (name === "open_preview") {
          const previewId = args?.previewId ? String(args.previewId) : "";
          if (!previewId) throw new Error("previewId is required; call list_previews for the available ids");
          answer = await picker.openPreview(workspace, previewId, device, agentId);
        } else throw new Error(`Unknown tool ${name}`);
        return result({ content: [{ type: "text", text: answer }] });
      } catch (error) {
        return result({ content: [{ type: "text", text: text(error) }], isError: true });
      }
    }
    default:
      return {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported method ${message.method}` },
      };
  }
}

/**
 * Answers agents' picker bridges (server/picker-bridge.mjs), one POST per MCP message with the
 * agent's workspace in the query, on a Unix socket only this user can open.
 */
export function servePicker(socketPath: string, picker: Picker): () => void {
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => (body += chunk));
    req.on("end", async () => {
      let answer: object | null;
      try {
        const query = new URL(req.url ?? "/", "http://picker").searchParams;
        const workspace = query.get("workspace");
        const agentId = query.get("agent") || undefined;
        answer = await reply(JSON.parse(body) as Message, JSON.parse(workspace ?? "") as Workspace, picker, agentId);
      } catch (error) {
        answer = { jsonrpc: "2.0", id: null, error: { code: -32700, message: text(error) } };
      }
      res.end(answer ? JSON.stringify(answer) : "");
    });
  });
  server.on("error", (error) => console.error("device picker:", error));
  mkdirSync(path.dirname(socketPath), { recursive: true });
  rmSync(socketPath, { force: true });
  server.listen(socketPath, () => chmodSync(socketPath, 0o600));
  return () => server.close();
}

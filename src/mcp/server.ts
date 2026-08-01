/**
 * MCP server -- a thin transport that exposes the Dispatch API tools (./tools)
 * to an operator over stdio. It owns no logic; the control plane does.
 * This is the "hybrid: daemon + MCP" surface from ARCHITECTURE section 18.
 *
 * IMPORTANT: stdout is the MCP protocol channel. Never write to stdout here;
 * diagnostics go to stderr.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DaemonRuntime } from "../daemon/runtime.js";
import { createTools, type CreateToolsOptions, type LoomTool } from "./tools.js";

export interface ServeMcpOptions extends CreateToolsOptions {
  readonly version?: string;
}

export async function serveMcp(rt: DaemonRuntime, opts: ServeMcpOptions = {}): Promise<void> {
  const version = opts.version ?? "0.3.0";
  const tools: LoomTool[] = createTools(rt, opts);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server({ name: "loom", version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: "object" },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return { content: [{ type: "text" as const, text: `unknown tool: ${req.params.name}` }], isError: true };
    }
    try {
      const result = await tool.handler((req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: JSON.stringify(result ?? null, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `error: ${String(err)}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`loom MCP server ready (${tools.length} tools)\n`);
}

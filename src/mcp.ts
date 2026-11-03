/**
 * Minimal MCP server implementation — replaces @modelcontextprotocol/sdk.
 *
 * Implements the MCP protocol (2024-11-05) over STDIO using JSON-RPC 2.0.
 * Only supports the "tools" capability (no resources, prompts, sampling).
 *
 * Wire format: newline-delimited JSON on stdin/stdout.
 */

import { z, type ZodRawShape, type ZodObject } from "zod";
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Server ─────────────────────────────────────────────────────────────────

export class McpServer {
  private tools = new Map<string, ToolDefinition>();
  private initialized = false;

  constructor(
    private readonly name: string,
    private readonly version: string
  ) {}

  /**
   * Register a tool with a zod schema for input validation.
   */
  tool<T extends ZodRawShape>(
    name: string,
    description: string,
    schema: T,
    handler: (args: z.infer<ZodObject<T>>) => Promise<ToolResult>
  ): void {
    const zodSchema = z.object(schema);
    const jsonSchema = z.toJSONSchema(zodSchema, { target: "draft-07" });

    this.tools.set(name, {
      name,
      description,
      inputSchema: jsonSchema as Record<string, unknown>,
      handler: async (args) => {
        const parsed = zodSchema.safeParse(args);
        if (!parsed.success) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Invalid parameters",
                  details: parsed.error.issues.map((i) => ({
                    path: i.path.join("."),
                    message: i.message,
                  })),
                }),
              },
            ],
            isError: true,
          };
        }
        return handler(parsed.data);
      },
    });
  }

  /**
   * Start listening on STDIO transport.
   */
  async serveStdio(): Promise<void> {
    const rl = createInterface({ input: process.stdin, terminal: false });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let request: JsonRpcRequest;
      try {
        request = JSON.parse(trimmed);
      } catch {
        this.sendStdio({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
        return;
      }

      const response = await this.handleRequest(request);
      if (response) {
        this.sendStdio(response);
      }
    });

    rl.on("close", () => {
      process.exit(0);
    });

    process.stderr.write(
      `[${this.name}] MCP server running on STDIO (protocol 2024-11-05)\n`
    );
  }

  /**
   * Start listening on HTTP/SSE transport.
   *
   * POST /mcp   — JSON-RPC request → JSON response (simple calls)
   * POST /mcp   — JSON-RPC request → SSE stream (for long-running tools)
   * GET  /mcp   — SSE stream for server-initiated messages
   * GET  /health — health check
   *
   * For simplicity, this implementation returns JSON responses for all
   * tool calls (no streaming). SSE is used only for the GET endpoint
   * as a keep-alive/notification channel.
   */
  async serveHttp(host: string, port: number): Promise<void> {
    const server = createServer(async (req, res) => {
      // CORS headers for browser-based MCP clients
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Mcp-Session-Id"
      );

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", name: this.name }));
        return;
      }

      if (req.url === "/mcp" && req.method === "GET") {
        // SSE endpoint — keep-alive stream for server-initiated messages
        this.handleSseEndpoint(res);
        return;
      }

      if (req.url === "/mcp" && req.method === "POST") {
        await this.handleHttpPost(req, res);
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Not found. Use POST /mcp for MCP protocol." })
      );
    });

    server.listen(port, host, () => {
      console.log(
        `[${this.name}] MCP server running on http://${host}:${port}/mcp`
      );
      console.log(`[${this.name}] Health check: http://${host}:${port}/health`);
    });
  }

  private handleSseEndpoint(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send an initial comment as keep-alive
    res.write(": connected\n\n");

    // Keep connection open — ping every 30s
    const pingInterval = setInterval(() => {
      res.write(": ping\n\n");
    }, 30_000);

    res.on("close", () => {
      clearInterval(pingInterval);
    });
  }

  private async handleHttpPost(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString();

    let request: JsonRpcRequest;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })
      );
      return;
    }

    const response = await this.handleRequest(request);

    if (response) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    } else {
      // Notification — accepted but no response body
      res.writeHead(202);
      res.end();
    }
  }

  private async handleRequest(
    req: JsonRpcRequest
  ): Promise<JsonRpcResponse | null> {
    // Notifications (no id) don't get responses
    const isNotification = req.id === undefined || req.id === null;

    switch (req.method) {
      case "initialize":
        this.initialized = true;
        return this.respond(req.id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: this.name,
            version: this.version,
          },
        });

      case "notifications/initialized":
        // Client confirms initialization — no response needed
        return null;

      case "ping":
        return this.respond(req.id, {});

      case "tools/list":
        return this.respond(req.id, {
          tools: Array.from(this.tools.values()).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call": {
        const toolName = (req.params as { name?: string })?.name;
        const toolArgs =
          (req.params as { arguments?: Record<string, unknown> })?.arguments ??
          {};

        if (!toolName) {
          return this.respondError(req.id, -32602, "Missing tool name");
        }

        const tool = this.tools.get(toolName);
        if (!tool) {
          return this.respondError(
            req.id,
            -32602,
            `Unknown tool: ${toolName}`
          );
        }

        try {
          const result = await tool.handler(toolArgs);
          return this.respond(req.id, result);
        } catch (err) {
          return this.respond(req.id, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "Tool execution failed",
                  details: String(err),
                }),
              },
            ],
            isError: true,
          });
        }
      }

      default:
        if (isNotification) return null;
        return this.respondError(
          req.id,
          -32601,
          `Method not found: ${req.method}`
        );
    }
  }

  private respond(
    id: string | number | null | undefined,
    result: unknown
  ): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id ?? null, result };
  }

  private respondError(
    id: string | number | null | undefined,
    code: number,
    message: string
  ): JsonRpcResponse {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  }

  private sendStdio(response: JsonRpcResponse): void {
    // MCP STDIO: one JSON object per line on stdout
    process.stdout.write(JSON.stringify(response) + "\n");
  }
}

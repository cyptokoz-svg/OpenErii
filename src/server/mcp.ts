import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import type { Tool } from 'ai'
import type { Plugin, EngineContext } from '../core/types.js'
import type { ToolCenter } from '../core/tool-center.js'

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

function toMcpContent(result: unknown): McpContent[] {
  if (
    result != null &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const items = (result as { content: Array<Record<string, unknown>> }).content
    const blocks: McpContent[] = []
    for (const item of items) {
      if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        blocks.push({ type: 'image', data: item.data, mimeType: item.mimeType })
      } else if (item.type === 'text' && typeof item.text === 'string') {
        blocks.push({ type: 'text', text: item.text })
      } else {
        blocks.push({ type: 'text', text: JSON.stringify(item) })
      }
    }
    if ('details' in result && (result as { details: unknown }).details != null) {
      blocks.push({ type: 'text', text: JSON.stringify((result as { details: unknown }).details) })
    }
    return blocks.length > 0 ? blocks : [{ type: 'text', text: JSON.stringify(result) }]
  }
  return [{ type: 'text', text: JSON.stringify(result) }]
}

/**
 * MCP Plugin — exposes tools via Streamable HTTP + SSE.
 *
 * - :port/mcp      → Streamable HTTP (new MCP spec)
 * - :port+100/sse  → SSE (Claude Code CLI compatibility)
 */
export class McpPlugin implements Plugin {
  name = 'mcp'
  private server: ReturnType<typeof serve> | null = null
  private sseServer: ReturnType<typeof createServer> | null = null

  constructor(
    private toolCenter: ToolCenter,
    private port: number,
  ) {}

  private async createMcpServer() {
    const tools = await this.toolCenter.getMcpTools()
    const mcp = new McpServer({ name: 'open-alice', version: '1.0.0' })

    for (const [name, t] of Object.entries(tools)) {
      if (!t.execute) continue
      const shape = (t.inputSchema as any)?.shape ?? {}

      mcp.registerTool(name, {
        description: t.description,
        inputSchema: shape,
      }, async (args: any) => {
        try {
          const result = await t.execute!(args, {
            toolCallId: crypto.randomUUID(),
            messages: [],
          })
          return { content: toMcpContent(result) }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${err}` }],
            isError: true,
          }
        }
      })
    }

    return mcp
  }

  async start(_ctx: EngineContext) {
    // ==================== Streamable HTTP (Hono) ====================

    const app = new Hono()

    app.use('*', cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
      exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    }))

    app.all('/mcp', async (c) => {
      const transport = new WebStandardStreamableHTTPServerTransport()
      const mcp = await this.createMcpServer()
      await mcp.connect(transport)
      return transport.handleRequest(c.req.raw)
    })

    this.server = serve({ fetch: app.fetch, port: this.port }, (info) => {
      console.log(`mcp plugin listening on http://localhost:${info.port}/mcp`)
    })

    // ==================== SSE (native HTTP, for Claude Code CLI) ====================

    const ssePort = this.port + 100
    const sseTransports = new Map<string, SSEServerTransport>()
    const self = this

    this.sseServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      const url = new URL(req.url ?? '/', `http://localhost:${ssePort}`)

      try {
        // GET /sse — establish SSE connection
        if (req.method === 'GET' && url.pathname === '/sse') {
          const transport = new SSEServerTransport('/messages', res)
          sseTransports.set(transport.sessionId, transport)

          transport.onclose = () => {
            sseTransports.delete(transport.sessionId)
          }

          const mcp = await self.createMcpServer()
          await mcp.connect(transport)
          await transport.start()
          return
        }

        // POST /messages — SSE message handler
        if (req.method === 'POST' && url.pathname === '/messages') {
          const sessionId = url.searchParams.get('sessionId')
          if (!sessionId || !sseTransports.has(sessionId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Unknown session' }))
            return
          }
          const transport = sseTransports.get(sessionId)!
          await transport.handlePostMessage(req, res)
          return
        }

        // Health check
        if (req.method === 'GET' && url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ status: 'ok', transport: 'sse', sessions: sseTransports.size }))
          return
        }
      } catch (err) {
        console.error('mcp sse error:', err)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(err) }))
        }
        return
      }

      res.writeHead(404)
      res.end('Not Found')
    })

    this.sseServer.listen(ssePort, () => {
      console.log(`mcp sse listening on http://localhost:${ssePort}/sse`)
    })
  }

  async stop() {
    this.server?.close()
    this.sseServer?.close()
  }
}

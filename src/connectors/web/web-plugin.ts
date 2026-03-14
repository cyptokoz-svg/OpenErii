import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { resolve } from 'node:path'
import type { Plugin, EngineContext } from '../../core/types.js'
import { SessionStore } from '../../core/session.js'
import { WebConnector } from './web-connector.js'
import { readWebSubchannels } from '../../core/config.js'
import { createChatRoutes, createMediaRoutes, type SSEClient } from './routes/chat.js'
import { createChannelsRoutes } from './routes/channels.js'
import { createConfigRoutes, createOpenbbRoutes } from './routes/config.js'
import { createEventsRoutes } from './routes/events.js'
import { createCronRoutes } from './routes/cron.js'
import { createHeartbeatRoutes } from './routes/heartbeat.js'
import { createTradingRoutes } from './routes/trading.js'
import { createTradingConfigRoutes } from './routes/trading-config.js'
import { createDevRoutes } from './routes/dev.js'
import { createToolsRoutes } from './routes/tools.js'
import { createAtlasRoutes } from './routes/atlas.js'
import { loadAtlasConfig } from '../../extension/atlas/config.js'
import { AtlasPipeline } from '../../extension/atlas/pipeline.js'
import { ensureAtlasChannels, deptChannelId } from '../../extension/atlas/channels.js'
import type { AtlasConfig, AgentConfig, Envelope, PipelineCallbacks } from '../../extension/atlas/types.js'
import type { LLMCallFn } from '../../extension/atlas/runner.js'

export interface WebConfig {
  port: number
}

export class WebPlugin implements Plugin {
  name = 'web'
  private server: ReturnType<typeof serve> | null = null
  /** SSE clients grouped by channel ID. Default channel: 'default'. */
  private sseByChannel = new Map<string, Map<string, SSEClient>>()
  private unregisterConnector?: () => void

  // Atlas state — initialized lazily after start()
  private atlasPipeline: AtlasPipeline | null = null
  private atlasConfig: AtlasConfig | null = null

  constructor(private config: WebConfig) {}

  async start(ctx: EngineContext) {
    // Load sub-channel definitions
    const subChannels = await readWebSubchannels()

    // Initialize sessions for the default channel and all sub-channels
    const sessions = new Map<string, SessionStore>()

    const defaultSession = new SessionStore('web/default')
    await defaultSession.restore()
    sessions.set('default', defaultSession)

    for (const ch of subChannels) {
      const session = new SessionStore(`web/${ch.id}`)
      await session.restore()
      sessions.set(ch.id, session)
    }

    // Initialize SSE map for known channels (entries are created lazily too)
    this.sseByChannel.set('default', new Map())
    for (const ch of subChannels) {
      this.sseByChannel.set(ch.id, new Map())
    }

    // ==================== Atlas Init ====================
    await this.initAtlas(ctx)

    const app = new Hono()

    app.onError((err: Error, c: Context) => {
      if (err instanceof SyntaxError) {
        return c.json({ error: 'Invalid JSON' }, 400)
      }
      console.error('web: unhandled error:', err)
      return c.json({ error: err.message }, 500)
    })

    app.use('/api/*', cors())

    // ==================== Mount route modules ====================
    app.route('/api/chat', createChatRoutes({ ctx, sessions, sseByChannel: this.sseByChannel }))
    app.route('/api/channels', createChannelsRoutes({ sessions, sseByChannel: this.sseByChannel }))
    app.route('/api/media', createMediaRoutes())
    app.route('/api/config', createConfigRoutes({
      onConnectorsChange: async () => { await ctx.reconnectConnectors() },
    }))
    app.route('/api/openbb', createOpenbbRoutes())
    app.route('/api/events', createEventsRoutes(ctx))
    app.route('/api/cron', createCronRoutes(ctx))
    app.route('/api/heartbeat', createHeartbeatRoutes(ctx))
    app.route('/api/trading/config', createTradingConfigRoutes(ctx))
    app.route('/api/trading', createTradingRoutes(ctx))
    app.route('/api/dev', createDevRoutes(ctx.connectorCenter))
    app.route('/api/tools', createToolsRoutes(ctx.toolCenter))
    app.route('/api/atlas', createAtlasRoutes({
      getPipeline: () => this.atlasPipeline,
      getConfig: () => this.atlasConfig,
    }))

    // ==================== Serve UI (Vite build output) ====================
    const uiRoot = resolve('dist/ui')
    app.use('/*', serveStatic({ root: uiRoot }))
    app.get('*', serveStatic({ root: uiRoot, path: 'index.html' }))

    // ==================== Connector registration ====================
    // The web connector only targets the main 'default' channel (heartbeat/cron notifications).
    this.unregisterConnector = ctx.connectorCenter.register(
      new WebConnector(this.sseByChannel, defaultSession),
    )

    // ==================== Start server ====================
    this.server = serve({ fetch: app.fetch, port: this.config.port }, (info: { port: number }) => {
      console.log(`web plugin listening on http://localhost:${info.port}`)
    })
  }

  /** Initialize Atlas pipeline if config exists and is enabled. */
  private async initAtlas(ctx: EngineContext): Promise<void> {
    try {
      this.atlasConfig = await loadAtlasConfig()
    } catch {
      return // No atlas config — skip
    }
    if (!this.atlasConfig.enabled) {
      console.log('atlas: disabled in config')
      return
    }

    // Create research channels and init SSE maps for them
    const created = await ensureAtlasChannels(this.atlasConfig)
    for (const chId of created) {
      if (!this.sseByChannel.has(chId)) {
        this.sseByChannel.set(chId, new Map())
      }
    }
    // Also ensure existing atlas channels have SSE maps
    for (const dept of this.atlasConfig.departments) {
      const chId = deptChannelId(dept.id)
      if (!this.sseByChannel.has(chId)) {
        this.sseByChannel.set(chId, new Map())
      }
    }

    // SSE push helper
    const pushToChannel = (channelId: string, data: string) => {
      const clients = this.sseByChannel.get(channelId)
      if (!clients) return
      for (const client of clients.values()) {
        try { client.send(data) } catch { /* disconnected */ }
      }
    }

    // Pipeline callbacks — push agent analysis to research channels
    const callbacks: PipelineCallbacks = {
      onAgentComplete: (agent: AgentConfig, envelope: Envelope) => {
        for (const dept of this.atlasConfig!.departments) {
          if (!dept.enabled) continue
          pushToChannel(deptChannelId(dept.id), JSON.stringify({
            type: 'atlas-agent',
            agent: agent.display_name ?? agent.name,
            layer: agent.layer,
            direction: envelope.signal.direction,
            conviction: envelope.signal.conviction,
            reasoning: envelope.reasoning,
            positions: envelope.signal.positions,
            knowledge_updates: envelope.knowledge_updates,
            timestamp: envelope.timestamp,
          }))
        }
      },
      onLayerComplete: (synthesis) => {
        for (const dept of this.atlasConfig!.departments) {
          if (!dept.enabled) continue
          pushToChannel(deptChannelId(dept.id), JSON.stringify({
            type: 'atlas-layer',
            layer: synthesis.layer,
            direction: synthesis.direction,
            conviction: synthesis.conviction,
            agreement: synthesis.agreement_ratio,
            summary: synthesis.summary,
            timestamp: new Date().toISOString(),
          }))
        }
      },
      onReportComplete: (report) => {
        for (const dept of this.atlasConfig!.departments) {
          if (!dept.enabled) continue
          if (dept.name === report.department || dept.id === report.department) {
            pushToChannel(deptChannelId(dept.id), JSON.stringify({
              type: 'atlas-report',
              department: report.department,
              direction: report.direction,
              conviction: report.conviction,
              positions: report.positions,
              summary: report.summary,
              timestamp: report.timestamp,
            }))
          }
        }
      },
    }

    // LLM call — direct generateText (no tools/agent loop = fast)
    const llmCall: LLMCallFn = async (prompt: string, _model: string): Promise<string> => {
      const { generateText } = await import('ai')
      const { createModelFromConfig } = await import('../../ai-providers/vercel-ai-sdk/model-factory.js')
      const { model } = await createModelFromConfig()
      const result = await generateText({ model, prompt })
      return result.text
    }

    // Data fetch — simplified: return empty context (no opentypebb wiring for now)
    const dataFetch = async (): Promise<string> => {
      return '[No live data connected — configure opentypebb data sources]'
    }

    // Should-run — always run for now
    const shouldRunAgent = async (): Promise<boolean> => true

    this.atlasPipeline = new AtlasPipeline({
      atlasConfig: this.atlasConfig,
      llmCall,
      dataFetch,
      shouldRunAgent,
      callbacks,
    })

    console.log(`atlas: initialized with ${this.atlasConfig.departments.filter(d => d.enabled).length} departments`)
  }

  async stop() {
    this.sseByChannel.clear()
    this.unregisterConnector?.()
    this.server?.close()
  }
}

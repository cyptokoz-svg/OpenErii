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
import { AutoResearch } from '../../extension/atlas/autoresearch.js'
import { createAtlasTools } from '../../extension/atlas/adapter.js'
import { DataBridge, type DataBridgeDeps } from '../../extension/atlas/data-bridge.js'
import type { NewsCollectorStore } from '../../extension/news-collector/store.js'
import type { EquityClientLike } from '../../openbb/sdk/types.js'
import type { PriceBar } from '../../extension/atlas/data-bridge.js'
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
  private sessions = new Map<string, SessionStore>()

  constructor(private config: WebConfig) {}

  async start(ctx: EngineContext) {
    // Load sub-channel definitions
    const subChannels = await readWebSubchannels()

    // Initialize sessions for the default channel and all sub-channels
    const defaultSession = new SessionStore('web/default')
    await defaultSession.restore()
    this.sessions.set('default', defaultSession)

    for (const ch of subChannels) {
      const session = new SessionStore(`web/${ch.id}`)
      await session.restore()
      this.sessions.set(ch.id, session)
    }

    // Local alias for route handlers
    const sessions = this.sessions

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

    // Direction emoji helper
    const dirEmoji = (d: string) => d === 'bullish' ? '🟢' : d === 'bearish' ? '🔴' : '⚪'
    // Agent Chinese name lookup
    const AGENT_ZH: Record<string, string> = {
      fed_watcher: '美联储观察', dollar_fx: '美元/外汇', inflation_tracker: '通胀追踪',
      geopolitical: '地缘政治', global_central_banks: '全球央行', yield_curve: '收益率曲线',
      liquidity_monitor: '流动性监测', china_macro: '中国宏观', emerging_markets: '新兴市场',
      shipping_logistics: '航运物流', energy_desk: '能源分析', precious_metals: '贵金属分析',
      industrial_metals: '工业金属分析', agriculture: '农产品分析', soft_commodities: '软商品分析',
      livestock: '畜牧业分析', carbon_esg: '碳排放与ESG', trend_follower: '趋势跟踪',
      mean_reversion: '均值回归', fundamental_value: '基本面价值', event_driven: '事件驱动',
      cro: '首席风控官', portfolio_manager: '投资组合经理', devils_advocate: '魔鬼代言人',
      cio: '首席投资官',
    }
    const agentName = (a: AgentConfig) => AGENT_ZH[a.name] ?? a.display_name ?? a.name

    // Pipeline callbacks — push agent analysis as chat messages to research channel
    const callbacks: PipelineCallbacks = {
      // Bug #9 fix: departmentId is now passed by pipeline, push only to correct channel
      onAgentComplete: (agent: AgentConfig, envelope: Envelope, departmentId: string) => {
        const dir = envelope.signal.direction
        const conv = envelope.signal.conviction
        const summary = envelope.reasoning?.summary ?? ''
        const factors = (envelope.reasoning?.key_factors ?? []).map((f: string) => `  • ${f}`).join('\n')
        const caveats = envelope.reasoning?.caveats ?? ''
        // Bug #6 fix: use p.ticker (not p.asset which doesn't exist on Position type)
        const positions = (envelope.signal.positions ?? []).map((p: any) => `  📌 ${p.ticker}${p.name ? ` (${p.name})` : ''}: ${p.direction} ${p.size_pct}%`).join('\n')

        const text = [
          `${dirEmoji(dir)} **${agentName(agent)}** [${agent.layer}]`,
          // Bug #7 fix: conviction is 0-100, display as /100
          `方向: ${dir}  信心: ${conv}/100`,
          '',
          summary,
          factors ? `\n关键因素:\n${factors}` : '',
          caveats ? `\n⚠ 风险提示: ${caveats}` : '',
          positions ? `\n建议持仓:\n${positions}` : '',
        ].filter(Boolean).join('\n')

        // Bug #9 fix: only push to the specific department channel being analyzed
        pushToChannel(deptChannelId(departmentId), JSON.stringify({
          type: 'message', kind: 'notification', text,
        }))
      },
      // Bug #9 fix: departmentId is now passed by pipeline
      onLayerComplete: (synthesis, departmentId: string) => {
        const text = [
          `━━━ ${synthesis.layer} 层级综合 ━━━`,
          // Bug #5 fix: agreement_ratio is already 0-100, don't multiply again
          // Bug #7 fix: conviction is 0-100, display as /100
          `${dirEmoji(synthesis.direction)} 方向: ${synthesis.direction}  信心: ${synthesis.conviction}/100  一致性: ${synthesis.agreement_ratio}%`,
          '',
          synthesis.summary,
        ].join('\n')

        // Bug #9 fix: only push to the specific department channel
        pushToChannel(deptChannelId(departmentId), JSON.stringify({
          type: 'message', kind: 'notification', text,
        }))
      },
      onReportComplete: (report) => {
        // Bug #6 fix: use p.ticker (not p.asset)
        const positions = (report.positions ?? []).map((p: any) => `  📌 ${p.ticker}${p.name ? ` (${p.name})` : ''}: ${p.direction} ${p.size_pct}%`).join('\n')
        const text = [
          `🏁 ═══ 最终投资报告 ═══`,
          // Bug #7 fix: conviction is 0-100
          `${dirEmoji(report.direction)} 方向: ${report.direction}  信心: ${report.conviction}/100`,
          '',
          report.summary,
          positions ? `\n持仓建议:\n${positions}` : '',
        ].filter(Boolean).join('\n')

        // Push to the specific department channel
        pushToChannel(deptChannelId(report.department), JSON.stringify({
          type: 'message', kind: 'notification', text,
        }))

        // Also push a concise conclusion to Alice's main channel
        const mainText = [
          `📋 投研团队报告 — ${report.department}`,
          // Bug #7 fix: conviction is 0-100
          `${dirEmoji(report.direction)} 方向: ${report.direction}  信心: ${report.conviction}/100`,
          '',
          report.summary,
          positions ? `\n持仓建议:\n${positions}` : '',
          '',
          '💡 详细分析请切换到 #投研: 大宗商品 频道查看',
        ].filter(Boolean).join('\n')

        pushToChannel('default', JSON.stringify({
          type: 'message', kind: 'notification', text: mainText,
        }))

        // Persist to Alice's default session so she knows about the report
        const aliceSession = this.sessions.get('default')
        if (aliceSession) {
          aliceSession.appendAssistant(mainText, 'notification', {
            source: 'atlas',
            department: report.department,
            direction: report.direction,
            conviction: report.conviction,
          }).catch(() => { /* best-effort */ })
        }

        // Also persist to the research channel session
        const deptSession = this.sessions.get(deptChannelId(report.department))
        if (deptSession) {
          deptSession.appendAssistant(text, 'notification', {
            source: 'atlas',
            department: report.department,
          }).catch(() => { /* best-effort */ })
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

    // Wire DataBridge with real data sources from ctx.extensions
    const newsStore = ctx.extensions?.newsStore as NewsCollectorStore | undefined
    const equityClient = ctx.extensions?.equityClient as EquityClientLike | undefined

    // Interval → OpenBB interval mapping
    const intervalMap: Record<string, string> = {
      '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w', '1M': '1M',
    }

    const dataBridgeDeps: DataBridgeDeps = {
      fetchPrice: async (symbol: string, interval: string): Promise<PriceBar[]> => {
        if (!equityClient) return []
        try {
          const obbInterval = intervalMap[interval] ?? '1d'
          // Build start_date: go back enough bars for 20-bar lookback
          const daysBack = obbInterval === '1d' ? 30 : obbInterval === '4h' ? 10 : 5
          const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 10)
          const rows = await equityClient.getHistorical({
            symbol,
            start_date: startDate,
            interval: obbInterval,
          })
          return rows.map((r) => ({
            date: String(r.date ?? ''),
            open: Number(r.open ?? 0),
            high: Number(r.high ?? 0),
            low: Number(r.low ?? 0),
            close: Number(r.close ?? 0),
            volume: Number(r.volume ?? 0),
          }))
        } catch (err) {
          console.warn(`atlas: fetchPrice failed for ${symbol} (${interval}):`, err)
          return []
        }
      },
      fetchMacro: async (_provider: string, _query: string, _symbols: string[]) => {
        // Macro data (FRED series etc.) requires a dedicated macro client
        // which is not currently available in the OpenBB adapter layer.
        // Agents will receive empty macro data and rely on LLM knowledge.
        return []
      },
      newsStore: newsStore!,
    }

    let dataFetch: (agent: AgentConfig, deptId: string) => Promise<string>
    let shouldRunAgent: (agent: AgentConfig, deptId: string) => Promise<boolean>

    if (newsStore) {
      const dataBridge = new DataBridge(dataBridgeDeps)
      dataFetch = (agent, deptId) => dataBridge.fetchForAgent(agent, deptId)
      shouldRunAgent = (agent, deptId) => dataBridge.shouldRun(agent, deptId)
    } else {
      console.warn('atlas: newsStore not available via ctx.extensions, agents will receive no live data')
      dataFetch = async () => ''
      shouldRunAgent = async () => true
    }

    this.atlasPipeline = new AtlasPipeline({
      atlasConfig: this.atlasConfig,
      llmCall,
      dataFetch,
      shouldRunAgent,
      callbacks,
    })

    // Bug #1-2 fix: Register Atlas tools with ToolCenter so Alice can trigger analysis via conversation/cron
    const autoResearchers = new Map<string, AutoResearch>()
    const atlasTools = createAtlasTools({
      pipeline: this.atlasPipeline,
      config: this.atlasConfig,
      // Bug #3 fix: Create AutoResearch instances for self-evolution loop
      getAutoResearch: (deptId: string) => {
        let ar = autoResearchers.get(deptId)
        if (!ar) {
          ar = new AutoResearch(
            deptId,
            this.atlasConfig!,
            this.atlasPipeline!.getScorecard(deptId),
            llmCall,
          )
          autoResearchers.set(deptId, ar)
        }
        return ar
      },
    })
    ctx.toolCenter.register(atlasTools, 'atlas')

    console.log(`atlas: initialized with ${this.atlasConfig.departments.filter(d => d.enabled).length} departments`)
  }

  async stop() {
    this.sseByChannel.clear()
    this.unregisterConnector?.()
    this.server?.close()
  }
}

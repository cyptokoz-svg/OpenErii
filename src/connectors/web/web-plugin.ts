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
import { CotClient } from '../../openbb/cot/client.js'
import { VolatilityClient } from '../../openbb/volatility/client.js'
import { WeatherClient } from '../../openbb/weather/client.js'
import type { SDKDerivativesClient } from '../../openbb/sdk/derivatives-client.js'
import { loadAtlasConfig } from '../../extension/atlas/config.js'
import { AtlasPipeline } from '../../extension/atlas/pipeline.js'
import { ensureAtlasChannels, deptChannelId } from '../../extension/atlas/channels.js'
import { AutoResearch } from '../../extension/atlas/autoresearch.js'
import { createAtlasTools } from '../../extension/atlas/adapter.js'
import { DataBridge, type DataBridgeDeps, type GenericClient } from '../../extension/atlas/data-bridge.js'
import { NewsRouter } from '../../extension/atlas/news-router.js'
import type { NewsCollectorStore } from '../../extension/news-collector/store.js'
import type { EquityClientLike } from '../../openbb/sdk/types.js'
import type { PriceBar } from '../../extension/atlas/data-bridge.js'
import type { DataSourceType } from '../../extension/atlas/types.js'
import type { AtlasConfig, AgentConfig, Envelope, PipelineCallbacks } from '../../extension/atlas/types.js'
import type { LLMCallFn } from '../../extension/atlas/runner.js'
import type { WalkForwardDeps } from '../../extension/atlas/backtest/index.js'

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
  private atlasLlmCall: LLMCallFn | null = null
  private atlasDataBridgeDeps: DataBridgeDeps | null = null
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

    // ==================== Auth ====================
    const webPassword = process.env.WEB_PASSWORD
    if (webPassword) {
      const AUTH_COOKIE = 'erii_auth'
      const loginPage = (error = false) => `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenErii</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0a0a0f;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .card {
      background: #13131a;
      border: 1px solid #2a2a3a;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .logo {
      text-align: center;
      margin-bottom: 32px;
    }
    .logo h1 {
      font-size: 28px;
      font-weight: 700;
      color: #fff;
      letter-spacing: -0.5px;
    }
    .logo span { color: #6366f1; }
    .logo p { color: #666; font-size: 13px; margin-top: 6px; }
    input {
      width: 100%;
      padding: 12px 16px;
      background: #1e1e2e;
      border: 1px solid #2a2a3a;
      border-radius: 10px;
      color: #fff;
      font-size: 15px;
      margin-bottom: 12px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: #6366f1; }
    input::placeholder { color: #444; }
    button {
      width: 100%;
      padding: 13px;
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 4px;
      transition: background 0.2s;
    }
    button:hover { background: #5254cc; }
    .error {
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      color: #f87171;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 16px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <h1>Open<span>Erii</span></h1>
      <p>AI Trading Research Platform</p>
    </div>
    ${error ? '<div class="error">密码错误，请重试</div>' : ''}
    <form method="POST" action="/__auth/login">
      <input type="password" name="password" placeholder="输入访问密码" autofocus autocomplete="current-password" />
      <button type="submit">进入</button>
    </form>
  </div>
</body>
</html>`

      // Login form
      app.get('/__auth/login', (c) => c.html(loginPage()))

      // Login submit
      app.post('/__auth/login', async (c) => {
        const body = await c.req.parseBody()
        if (body.password === webPassword) {
          const token = Buffer.from(`erii:${webPassword}`).toString('base64')
          c.header('Set-Cookie', `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`)
          return c.redirect('/')
        }
        return c.html(loginPage(true))
      })

      // Auth guard — skip for login routes
      app.use('/*', async (c, next) => {
        const path = new URL(c.req.url).pathname
        if (path.startsWith('/__auth')) return await next()
        const cookie = c.req.header('Cookie') ?? ''
        const token = Buffer.from(`erii:${webPassword}`).toString('base64')
        const valid = cookie.split(';').some((p) => p.trim() === `${AUTH_COOKIE}=${token}`)
        if (!valid) return c.redirect('/__auth/login')
        await next()
      })
    }

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
      getBacktestDeps: () => this.atlasConfig && this.atlasLlmCall && this.atlasDataBridgeDeps
        ? { atlasConfig: this.atlasConfig, llmCall: this.atlasLlmCall, dataBridgeDeps: this.atlasDataBridgeDeps }
        : null,
    }))

    // ==================== Serve UI (Vite build output) ====================
    const uiRoot = resolve('dist/ui')
    app.use('/*', serveStatic({ root: uiRoot }))
    // SPA fallback — serve index.html with no-cache so Safari always gets the latest
    app.get('*', async (c, next) => {
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate')
      c.header('Pragma', 'no-cache')
      c.header('Expires', '0')
      return serveStatic({ root: uiRoot, path: 'index.html' })(c, next)
    })

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
    // Also ensure existing atlas channels have SSE maps + sessions
    for (const dept of this.atlasConfig.departments) {
      const chId = deptChannelId(dept.id)
      if (!this.sseByChannel.has(chId)) {
        this.sseByChannel.set(chId, new Map())
      }
      // Create session for persistence (so messages survive page reload)
      if (!this.sessions.has(chId)) {
        const session = new SessionStore(`web/${chId}`)
        await session.restore()
        this.sessions.set(chId, session)
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
    const dirEmoji = (d: string) => d.toUpperCase() === 'BULLISH' ? '🟢' : d.toUpperCase() === 'BEARISH' ? '🔴' : '⚪'
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
        const positions = (envelope.signal.positions ?? []).map((p: any) => {
          const price = p.entry_price ? ` | 入场:${p.entry_price} 止损:${p.stop_loss ?? '-'} 目标:${(p.take_profit ?? []).join('/')}` : ''
          return `  📌 ${p.ticker}${p.name ? ` (${p.name})` : ''}: ${p.direction} ${p.size_pct}%${price}`
        }).join('\n')

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
        const channelId = deptChannelId(departmentId)
        pushToChannel(channelId, JSON.stringify({
          type: 'message', kind: 'notification', text,
        }))

        // Persist to channel session so messages survive page reload
        const session = this.sessions.get(channelId)
        if (session) {
          session.appendAssistant(text, 'notification', {
            source: 'atlas', agent: agent.name, layer: agent.layer,
          }).catch((err) => { console.warn('atlas: session persist failed:', err) })
        }
      },
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
        const layerChannelId = deptChannelId(departmentId)
        pushToChannel(layerChannelId, JSON.stringify({
          type: 'message', kind: 'notification', text,
        }))

        // Persist layer synthesis to channel session
        const layerSession = this.sessions.get(layerChannelId)
        if (layerSession) {
          layerSession.appendAssistant(text, 'notification', {
            source: 'atlas', layer: synthesis.layer,
          }).catch((err) => { console.warn('atlas: session persist failed:', err) })
        }
      },
      onReportComplete: (report) => {
        // Bug #6 fix: use p.ticker (not p.asset)
        const fmtPositions = (list: any[]) => list.map((p: any) => {
          const price = p.entry_price ? ` | 入场:${p.entry_price} 止损:${p.stop_loss ?? '-'} 目标:${(p.take_profit ?? []).join('/')}` : ''
          return `  📌 ${p.ticker}${p.name ? ` (${p.name})` : ''}: ${p.direction} ${p.size_pct}%${price}`
        }).join('\n')
        const positions = fmtPositions(report.positions ?? [])
        const text = [
          `🏁 ═══ 最终投资报告 ═══`,
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
          }).catch((err) => { console.warn('atlas: session persist failed:', err) })
        }

        // Also persist to the research channel session
        const deptSession = this.sessions.get(deptChannelId(report.department))
        if (deptSession) {
          deptSession.appendAssistant(text, 'notification', {
            source: 'atlas',
            department: report.department,
          }).catch((err) => { console.warn('atlas: session persist failed:', err) })
        }

        // Emit event to EventLog for audit trail + downstream listeners
        ctx.eventLog.append('atlas.complete', {
          department: report.department,
          direction: report.direction,
          conviction: report.conviction,
          positions: report.positions.map((p) => ({
            ticker: p.ticker, direction: p.direction, size_pct: p.size_pct,
          })),
          summary: report.summary,
          skipped_agents: report.skipped_agents.length,
          total_calls: report.cost_estimate.total_calls,
          skipped_calls: report.cost_estimate.skipped_calls,
        }).catch((err) => { console.warn('atlas: event log failed:', err) })
      },
    }

    // LLM call — uses Alice's AI config + Atlas model tier override
    const llmCall: LLMCallFn = async (prompt: string, model: string, abortSignal?: AbortSignal): Promise<string> => {
      const { readAIProviderConfig } = await import('../../core/config.js')
      const aiConfig = await readAIProviderConfig()

      // Try direct API call when API access is available (enables per-layer model selection)
      const hasApiAccess = aiConfig.backend === 'vercel-ai-sdk'
        || Object.values(aiConfig.apiKeys || {}).some((k) => !!k)
        || !!aiConfig.baseUrl

      if (hasApiAccess) {
        try {
          const { generateText } = await import('ai')
          const { createModelFromConfig } = await import('../../ai-providers/vercel-ai-sdk/model-factory.js')
          const { model: languageModel } = await createModelFromConfig(
            model ? { provider: aiConfig.provider || 'anthropic', model, baseUrl: aiConfig.baseUrl } : undefined,
          )
          const result = await generateText({ model: languageModel, prompt, abortSignal, maxTokens: 16000 })
          return result.text
        } catch (err) {
          console.warn(`atlas: direct API call failed (model=${model}), falling back to Claude Code CLI:`, err)
        }
      }

      // Fallback: use Claude Code CLI with model override
      const { askClaudeCode } = await import('../../ai-providers/claude-code/provider.js')
      const { readAgentConfig } = await import('../../core/config.js')
      const agentConfig = await readAgentConfig()
      const result = await askClaudeCode(prompt, {
        ...agentConfig.claudeCode,
        model: model || undefined,
        abortSignal,
      })
      return result.text
    }

    // Wire DataBridge with real data sources from ctx.extensions
    const newsStore = ctx.extensions?.newsStore as NewsCollectorStore | undefined
    const equityClient = ctx.extensions?.equityClient as EquityClientLike | undefined

    // Interval → OpenBB interval mapping
    // yfinance does not support '4h' — map to '1h' and use 15-day lookback to cover enough bars
    const intervalMap: Record<string, string> = {
      '15m': '15m', '1h': '1h', '4h': '1h', '1d': '1d', '1w': '1W', '1M': '1M',
    }

    // Build generic SDK clients map for DataBridge passthrough
    const sdkClients: Partial<Record<DataSourceType, GenericClient>> = {}
    if (equityClient) sdkClients.equity = equityClient as unknown as GenericClient
    if (ctx.extensions?.cryptoClient) sdkClients.crypto = ctx.extensions.cryptoClient as GenericClient
    if (ctx.extensions?.currencyClient) sdkClients.currency = ctx.extensions.currencyClient as GenericClient
    if (ctx.extensions?.economyClient) sdkClients.economy = ctx.extensions.economyClient as GenericClient
    if (ctx.extensions?.commodityClient) sdkClients.commodity = ctx.extensions.commodityClient as GenericClient
    if (ctx.extensions?.derivativesClient) sdkClients.derivatives = ctx.extensions.derivativesClient as unknown as GenericClient
    sdkClients.cot = new CotClient() as unknown as GenericClient
    sdkClients.volatility = new VolatilityClient() as unknown as GenericClient
    sdkClients.weather = new WeatherClient() as unknown as GenericClient

    const dataBridgeDeps: DataBridgeDeps = {
      fetchPrice: async (symbol: string, interval: string, startDateOverride?: string): Promise<PriceBar[]> => {
        if (!equityClient) return []
        try {
          const obbInterval = intervalMap[interval] ?? '1d'
          // Use override for backtest (full date range), otherwise lookback window.
          // '4h' maps to '1h' (yfinance limitation), so we use 15 days to ensure enough bars.
          let startDate: string
          if (startDateOverride) {
            startDate = startDateOverride
          } else {
            const daysBack = interval === '1d' ? 30 : interval === '4h' ? 15 : 5
            startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
              .toISOString().slice(0, 10)
          }
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
      fetchMacro: async (provider: string, query: string, symbols: string[]) => {
        // Route legacy macro sources through economy client if available
        const econ = sdkClients.economy
        if (!econ) return []
        try {
          if (query === 'fred' || provider === 'fred' || provider === 'federal_reserve' || query === 'fred_series') {
            // FRED series: call fredSeries for each symbol
            const results = []
            for (const sym of symbols) {
              const rows = await econ.fredSeries({ symbol: sym, limit: 5 })
              for (const r of rows) {
                results.push({
                  symbol: sym,
                  date: String(r.date ?? ''),
                  value: Number(r.value ?? 0),
                  label: String(r.title ?? ''),
                })
              }
            }
            return results
          }
          // EIA or other macro: try matching method name
          if (query.startsWith('eia.') || provider === 'eia') {
            const raw = query.startsWith('eia.') ? query.replace('eia.', '') : query
            const methodName = 'get' + raw.replace(/_(\w)/g, (_, c) => c.toUpperCase()).replace(/^(\w)/, (_, c) => c.toUpperCase())
            const fn = econ[methodName]
            if (typeof fn === 'function') {
              const rows = await fn.call(econ, {})
              return rows.map((r: Record<string, unknown>) => ({
                symbol: String(r.symbol ?? r.name ?? query),
                date: String(r.date ?? ''),
                value: Number(r.value ?? 0),
              }))
            }
          }
          return []
        } catch (err) {
          console.warn(`atlas: fetchMacro failed for ${provider}/${query}:`, err)
          return []
        }
      },
      newsStore: newsStore!,
      clients: sdkClients,
      newsRouter: new NewsRouter({ llmCall, aiEnabled: true, aiLimit: 10 }),
    }

    // Store for backtest deps access
    this.atlasLlmCall = llmCall
    this.atlasDataBridgeDeps = dataBridgeDeps

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
      fetchReturn: async (ticker: string, date: string, days: number): Promise<number | null> => {
        try {
          const startDate = new Date(date)
          const endDate = new Date(startDate)
          endDate.setDate(endDate.getDate() + days + 2)
          if (endDate.getTime() > Date.now()) return null

          const bars = await dataBridgeDeps.fetchPrice(ticker, '1d')
          if (bars.length < 2) return null

          const signalIdx = bars.findIndex((b) => b.date >= date)
          if (signalIdx < 0) return null
          const futureIdx = Math.min(signalIdx + days, bars.length - 1)
          if (futureIdx <= signalIdx) return null

          const entryPrice = bars[signalIdx].close
          const exitPrice = bars[futureIdx].close
          if (entryPrice === 0) return null
          return (exitPrice - entryPrice) / entryPrice
        } catch {
          return null
        }
      },
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
      getBacktestDeps: () => this.atlasConfig && this.atlasLlmCall && this.atlasDataBridgeDeps
        ? { atlasConfig: this.atlasConfig, llmCall: this.atlasLlmCall, dataBridgeDeps: this.atlasDataBridgeDeps }
        : null,
    })
    ctx.toolCenter.register(atlasTools, 'atlas')

    // Auto-create default cron jobs for enabled departments (idempotent)
    const existingJobs = ctx.cronEngine.list()
    for (const dept of this.atlasConfig.departments.filter((d) => d.enabled)) {
      const jobName = `atlas-${dept.id}`
      if (!existingJobs.some((j) => j.name === jobName)) {
        await ctx.cronEngine.add({
          name: jobName,
          schedule: { kind: 'every', every: '4h' },
          payload: `Run Atlas research analysis for the ${dept.name} department. Call the atlasAnalysis tool with department="${dept.id}".`,
          enabled: false, // disabled by default — user enables when ready
        })
        console.log(`atlas: created cron job "${jobName}" (disabled, every 4h)`)
      }
    }

    console.log(`atlas: initialized with ${this.atlasConfig.departments.filter(d => d.enabled).length} departments`)
  }

  async stop() {
    this.sseByChannel.clear()
    this.unregisterConnector?.()
    this.server?.close()
  }
}

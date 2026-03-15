/**
 * Atlas Bootstrap — Wire atlas research engine into Alice's runtime
 *
 * Initializes the pipeline, registers tools, creates research channels,
 * and sets up SSE callbacks for real-time agent message push.
 */

import type { EngineContext } from '../../core/types.js'
import type { SSEClient } from '../../connectors/web/routes/chat.js'
import type { GenerateRouter } from '../../core/ai-provider-manager.js'
import { loadAtlasConfig, loadDepartmentAgents } from './config.js'
import { AtlasPipeline, type PipelineConfig } from './pipeline.js'
import { DataBridge, type DataBridgeDeps } from './data-bridge.js'
import { AutoResearch } from './autoresearch.js'
import { createAtlasTools } from './adapter.js'
import { ensureAtlasChannels, deptChannelId } from './channels.js'
import type { AgentConfig, AtlasConfig, Envelope, PipelineCallbacks } from './types.js'
import type { LLMCallFn } from './runner.js'
import type { WalkForwardDeps } from './backtest/index.js'
import { createModelFromConfig } from '../../ai-providers/vercel-ai-sdk/model-factory.js'
import { readAIProviderConfig } from '../../core/config.js'

export interface AtlasBootstrapDeps {
  ctx: EngineContext
  sseByChannel: Map<string, Map<string, SSEClient>>
  generateRouter: GenerateRouter
  dataBridgeDeps: DataBridgeDeps
}

export interface AtlasBootstrapResult {
  pipeline: AtlasPipeline
  config: AtlasConfig
}

/**
 * Initialize Atlas and wire into Alice.
 * Returns null if Atlas is disabled or config is missing.
 */
export async function bootstrapAtlas(
  deps: AtlasBootstrapDeps,
): Promise<AtlasBootstrapResult | null> {
  const { ctx, sseByChannel, generateRouter, dataBridgeDeps } = deps

  // Load config
  let config: AtlasConfig
  try {
    config = await loadAtlasConfig()
  } catch {
    console.log('atlas: config not found, skipping initialization')
    return null
  }

  if (!config.enabled) {
    console.log('atlas: disabled in config')
    return null
  }

  // Create research sub-channels
  await ensureAtlasChannels(config)

  // Initialize data bridge
  const dataBridge = new DataBridge(dataBridgeDeps)

  // Build SSE push callback
  const pushToChannel = (channelId: string, data: string) => {
    const clients = sseByChannel.get(channelId)
    if (!clients) return
    for (const client of clients.values()) {
      try { client.send(data) } catch { /* disconnected */ }
    }
  }

  // Pipeline callbacks — push agent analysis to research channels
  const callbacks: PipelineCallbacks = {
    onAgentComplete: (agent: AgentConfig, envelope: Envelope, departmentId: string) => {
      const data = JSON.stringify({
        type: 'atlas-agent',
        agent: agent.display_name ?? agent.name,
        layer: agent.layer,
        direction: envelope.signal.direction,
        conviction: envelope.signal.conviction,
        reasoning: envelope.reasoning,
        positions: envelope.signal.positions,
        knowledge_updates: envelope.knowledge_updates,
        timestamp: envelope.timestamp,
      })
      pushToChannel(deptChannelId(departmentId), data)
    },
    onLayerComplete: (synthesis, departmentId: string) => {
      const data = JSON.stringify({
        type: 'atlas-layer',
        layer: synthesis.layer,
        direction: synthesis.direction,
        conviction: synthesis.conviction,
        agreement: synthesis.agreement_ratio,
        summary: synthesis.summary,
        timestamp: new Date().toISOString(),
      })
      pushToChannel(deptChannelId(departmentId), data)
    },
    onReportComplete: (report) => {
      // Final report → research channel for the specific department
      for (const dept of config.departments) {
        if (!dept.enabled) continue
        if (dept.name === report.department || dept.id === report.department) {
          const data = JSON.stringify({
            type: 'atlas-report',
            department: report.department,
            direction: report.direction,
            conviction: report.conviction,
            positions: report.positions,
            summary: report.summary,
            timestamp: report.timestamp,
          })
          pushToChannel(deptChannelId(dept.id), data)
        }
      }
    },
  }

  // LLM call function — uses Alice's credentials + Atlas's own model tier
  // Provider/apiKey/baseUrl syncs from Alice, model comes from Atlas model_tiers
  const llmCall: LLMCallFn = async (prompt: string, model: string): Promise<string> => {
    const aiConfig = await readAIProviderConfig()

    // Try direct API call with Atlas's model tier (always preferred — enables per-layer model selection)
    const hasApiAccess = aiConfig.backend === 'vercel-ai-sdk'
      || Object.values(aiConfig.apiKeys || {}).some((k) => !!k)
      || !!aiConfig.baseUrl // proxy like auth2api

    if (hasApiAccess) {
      try {
        const { generateText } = await import('ai')
        const { model: languageModel } = await createModelFromConfig(
          model ? { provider: aiConfig.provider || 'anthropic', model, baseUrl: aiConfig.baseUrl } : undefined,
        )
        const result = await generateText({ model: languageModel, prompt })
        return result.text
      } catch (err) {
        console.warn(`atlas: direct API call failed (model=${model}), falling back to generateRouter:`, err)
      }
    }

    // Fallback: use GenerateRouter (claude-code CLI — model tiers won't apply)
    const provider = await generateRouter.resolve()
    const result = await provider.ask(prompt)
    return result.text
  }

  // Data fetch function
  const dataFetch = async (agent: AgentConfig, deptId: string): Promise<string> => {
    return dataBridge.fetchForAgent(agent, deptId)
  }

  // Should-run check
  const shouldRunAgent = async (agent: AgentConfig, deptId: string): Promise<boolean> => {
    return dataBridge.shouldRun(agent, deptId)
  }

  // Forward return lookup for scoring past signals
  const fetchReturn = async (ticker: string, date: string, days: number): Promise<number | null> => {
    try {
      const startDate = new Date(date)
      const endDate = new Date(startDate)
      endDate.setDate(endDate.getDate() + days + 2) // extra buffer for weekends/holidays

      // Only score if enough time has passed
      if (endDate.getTime() > Date.now()) return null

      const bars = await dataBridgeDeps.fetchPrice(ticker, '1d')
      if (bars.length < 2) return null

      // Find the bar closest to signal date and the bar N days later
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
  }

  // Build pipeline
  const pipelineConfig: PipelineConfig = {
    atlasConfig: config,
    llmCall,
    dataFetch,
    shouldRunAgent,
    callbacks,
    fetchReturn,
  }
  const pipeline = new AtlasPipeline(pipelineConfig)

  // Build backtest deps factory
  const getBacktestDeps = (): WalkForwardDeps => ({
    atlasConfig: config,
    llmCall,
    dataBridgeDeps,
  })

  // Register tools
  const autoResearchers = new Map<string, AutoResearch>()
  const tools = createAtlasTools({
    pipeline,
    config,
    getAutoResearch: (deptId: string) => {
      let ar = autoResearchers.get(deptId)
      if (!ar) {
        ar = new AutoResearch(
          deptId,
          config,
          pipeline.getScorecard(deptId),
          llmCall,
        )
        autoResearchers.set(deptId, ar)
      }
      return ar
    },
    getBacktestDeps: () => getBacktestDeps(),
  })

  // Register tools with Alice's ToolCenter (batch registration under 'atlas' group)
  ctx.toolCenter.register(tools, 'atlas')

  console.log(`atlas: initialized with ${config.departments.filter((d) => d.enabled).length} departments`)

  return { pipeline, config }
}

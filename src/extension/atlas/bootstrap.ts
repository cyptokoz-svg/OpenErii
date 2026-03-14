/**
 * Atlas Bootstrap — Wire atlas research engine into Alice's runtime
 *
 * Initializes the pipeline, registers tools, creates research channels,
 * and sets up SSE callbacks for real-time agent message push.
 */

import type { EngineContext } from '../../core/types.js'
import type { SSEClient } from '../../connectors/web/routes/chat.js'
import type { GenerateRouter } from '../../core/ai-provider.js'
import { loadAtlasConfig, loadDepartmentAgents } from './config.js'
import { AtlasPipeline, type PipelineConfig } from './pipeline.js'
import { DataBridge, type DataBridgeDeps } from './data-bridge.js'
import { AutoResearch } from './autoresearch.js'
import { createAtlasTools } from './adapter.js'
import { ensureAtlasChannels, deptChannelId } from './channels.js'
import type { AgentConfig, AtlasConfig, Envelope, PipelineCallbacks } from './types.js'
import type { LLMCallFn } from './runner.js'

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
    onAgentComplete: (agent: AgentConfig, envelope: Envelope) => {
      // Derive department from the agent's envelope context
      // The pipeline passes this via the run opts
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
      // Push to all atlas department channels (the pipeline doesn't expose dept in callback args)
      for (const dept of config.departments) {
        if (!dept.enabled) continue
        pushToChannel(deptChannelId(dept.name), data)
      }
    },
    onLayerComplete: (synthesis) => {
      // Broadcast layer summary to all active department channels
      const data = JSON.stringify({
        type: 'atlas-layer',
        layer: synthesis.layer,
        direction: synthesis.direction,
        conviction: synthesis.conviction,
        agreement: synthesis.agreement_ratio,
        summary: synthesis.summary,
        timestamp: new Date().toISOString(),
      })
      for (const dept of config.departments) {
        if (!dept.enabled) continue
        pushToChannel(deptChannelId(dept.name), data)
      }
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
          pushToChannel(deptChannelId(dept.name), data)
        }
      }
    },
  }

  // LLM call function — uses Alice's GenerateRouter
  const llmCall: LLMCallFn = async (prompt: string, _model: string): Promise<string> => {
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

  // Build pipeline
  const pipelineConfig: PipelineConfig = {
    atlasConfig: config,
    llmCall,
    dataFetch,
    shouldRunAgent,
    callbacks,
  }
  const pipeline = new AtlasPipeline(pipelineConfig)

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
  })

  // Register tools with Alice's ToolCenter (batch registration under 'atlas' group)
  ctx.toolCenter.register(tools, 'atlas')

  console.log(`atlas: initialized with ${config.departments.filter((d) => d.enabled).length} departments`)

  return { pipeline, config }
}

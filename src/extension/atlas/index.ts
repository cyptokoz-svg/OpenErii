/**
 * Atlas Research Extension — Public API
 *
 * Re-exports all public-facing modules for the multi-department
 * research team engine.
 */

// Core
export { type Envelope, type AtlasConfig, type AtlasReport, type AgentConfig } from './types.js'
export { parseAgentOutput, buildEnvelope } from './envelope.js'
export { loadAtlasConfig, resolveModel, getKnowledgeVaultPath } from './config.js'

// Engine
export { AtlasPipeline } from './pipeline.js'
export { AgentRunner } from './runner.js'
export { synthesizeLayer } from './synthesizer.js'
export { KnowledgeGraph } from './knowledge.js'
export { Scorecard } from './scorecard.js'
export { AutoResearch } from './autoresearch.js'
export { DataBridge } from './data-bridge.js'

// Alice integration
export { createAtlasTools } from './adapter.js'
export { bootstrapAtlas } from './bootstrap.js'
export { ensureAtlasChannels, deptChannelId, agentChannelId } from './channels.js'

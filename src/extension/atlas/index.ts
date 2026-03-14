/**
 * Atlas Research Extension — Entry point
 *
 * Exports createAtlasTools() for registration in Alice's ToolCenter.
 */

export { createAtlasTools } from './adapter.js'
export type { AtlasToolsDeps } from './adapter.js'
export { AtlasPipeline } from './pipeline.js'
export type { PipelineConfig } from './pipeline.js'
export { DataBridge } from './data-bridge.js'
export type { DataBridgeDeps } from './data-bridge.js'
export { KnowledgeGraph } from './knowledge.js'
export { Scorecard } from './scorecard.js'
export { AutoResearch } from './autoresearch.js'
export { AgentRunner } from './runner.js'
export { loadAtlasConfig, getEnabledDepartments } from './config.js'
export type {
  AtlasConfig,
  AtlasReport,
  AtlasRunOpts,
  AgentConfig,
  DepartmentConfig,
  Envelope,
  Layer,
  Direction,
  PipelineCallbacks,
} from './types.js'

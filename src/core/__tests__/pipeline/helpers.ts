/**
 * Shared test infrastructure for message pipeline integration tests.
 *
 * MockAIProvider (aliased as FakeProvider), event builders, and helpers used
 * across the pipeline-*.spec.ts files. Session and connector test doubles are
 * imported from their respective modules (MemorySessionStore, MockConnector).
 */

import { AgentCenter } from '../../agent-center.js'
import { GenerateRouter, StreamableResult, type ProviderEvent } from '../../ai-provider-manager.js'
import { DEFAULT_COMPACTION_CONFIG } from '../../compaction.js'

// Re-export test doubles for convenience
export { MemorySessionStore } from '../../session.js'
export type { SessionEntry, ContentBlock } from '../../session.js'
export { MockConnector } from '../../../connectors/mock/index.js'
export type { MockConnectorCall } from '../../../connectors/mock/index.js'

// Re-export MockAIProvider as FakeProvider for backward compatibility with existing tests
export { MockAIProvider as FakeProvider } from '../../../ai-providers/mock/index.js'
export { textEvent, toolUseEvent, toolResultEvent, doneEvent } from '../../../ai-providers/mock/index.js'

// ==================== Helpers ====================

import type { MockAIProvider } from '../../../ai-providers/mock/index.js'

/** Create an AgentCenter wired to a MockAIProvider. */
export function makeAgentCenter(provider: MockAIProvider): AgentCenter {
  const router = new GenerateRouter(provider, null)
  return new AgentCenter({ router, compaction: DEFAULT_COMPACTION_CONFIG })
}

/** Collect all events from a StreamableResult into an array. */
export async function collectEvents(stream: StreamableResult): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  for await (const e of stream) events.push(e)
  return events
}

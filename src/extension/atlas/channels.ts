/**
 * Atlas Research Channels — Auto-register department-level sub-channel
 *
 * Creates ONE sub-channel per department for streaming research results.
 * Individual agents are NOT channels — they are shown in the Atlas page.
 */

import { readWebSubchannels, writeWebSubchannels } from '../../core/config.js'
import type { WebChannel } from '../../core/types.js'
import type { AtlasConfig } from './types.js'

/** Chinese labels for departments */
const DEPT_LABELS: Record<string, string> = {
  commodity: '投研: 大宗商品',
}

/** Channel ID for a department */
export function deptChannelId(dept: string): string {
  return `atlas-${dept}`
}

/**
 * Ensure ONE research sub-channel exists per enabled department.
 * This channel receives SSE events with agent analysis results.
 * Agents themselves are NOT channels — they show in the Atlas UI.
 *
 * Idempotent: skips channels that already exist.
 */
export async function ensureAtlasChannels(config: AtlasConfig): Promise<string[]> {
  const existing = await readWebSubchannels()
  const existingIds = new Set(existing.map((ch) => ch.id))
  const created: string[] = []

  for (const dept of config.departments) {
    if (!dept.enabled) continue

    const deptId = deptChannelId(dept.id)
    if (!existingIds.has(deptId)) {
      const deptLabel = DEPT_LABELS[dept.id] ?? `投研: ${dept.name}`
      const ch: WebChannel = {
        id: deptId,
        label: deptLabel,
        systemPrompt: `你是${deptLabel}部门的协调员。你负责总结和讨论团队分析师的最新研究分析。用户提问时，提供最近分析的背景信息。用中文回答。`,
      }
      existing.push(ch)
      existingIds.add(deptId)
      created.push(deptId)
    }
  }

  if (created.length > 0) {
    await writeWebSubchannels(existing)
    console.log(`atlas: created ${created.length} research channels: ${created.join(', ')}`)
  }

  return created
}

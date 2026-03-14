/**
 * Atlas Research Channels — Auto-register sub-channels for each department
 *
 * Creates sub-channels so agents can post real-time analysis content
 * and users can directly chat with departments or individual agents.
 */

import { readWebSubchannels, writeWebSubchannels } from '../../core/config.js'
import type { WebChannel } from '../../core/types.js'
import type { DepartmentConfig } from './types.js'
import { loadDepartmentAgents } from './config.js'
import type { AtlasConfig } from './types.js'

/** Chinese labels for departments and agents */
const DEPT_LABELS: Record<string, string> = {
  commodity: '投研: 大宗商品',
}

const AGENT_LABELS: Record<string, string> = {
  energy_desk: '能源分析',
  precious_metals: '贵金属分析',
  industrial_metals: '工业金属分析',
  agriculture: '农产品分析',
  soft_commodities: '软商品分析',
  livestock: '畜牧业分析',
  carbon_esg: '碳排放与ESG',
}

/** Channel ID conventions */
export function deptChannelId(dept: string): string {
  return `atlas-${dept}`
}

export function agentChannelId(dept: string, agentName: string): string {
  return `atlas-${dept}-${agentName}`
}

/**
 * Ensure research sub-channels exist for all enabled departments.
 * Creates:
 *   - `atlas-{dept}` — department research channel (shows all agent analysis)
 *   - `atlas-{dept}-{agent}` — per-agent chat channels (for chat_enabled agents)
 *
 * Idempotent: skips channels that already exist.
 */
export async function ensureAtlasChannels(config: AtlasConfig): Promise<string[]> {
  const existing = await readWebSubchannels()
  const existingIds = new Set(existing.map((ch) => ch.id))
  const created: string[] = []

  for (const dept of config.departments) {
    if (!dept.enabled) continue

    // Department research channel
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

    // Load agents for this department to create per-agent channels
    let agents
    try {
      agents = await loadDepartmentAgents(dept)
    } catch {
      console.warn(`atlas: skipping agent channel creation for ${dept.name} — agents not found`)
      continue
    }

    // Per-agent chat channels (only for chat_enabled agents)
    for (const agent of agents) {
      if (!agent.chat_enabled) continue

      const agentId = agentChannelId(dept.id, agent.name)
      if (!existingIds.has(agentId)) {
        const agentLabel = AGENT_LABELS[agent.name] ?? agent.display_name ?? agent.name
        const ch: WebChannel = {
          id: agentId,
          label: agentLabel,
          systemPrompt: `你是${agentLabel}，${DEPT_LABELS[dept.id] ?? dept.name}部门的专业研究员。你的职责是：${agent.name}。根据你的分析专长回答问题。用中文回答。Layer: ${agent.layer}.`,
        }
        existing.push(ch)
        existingIds.add(agentId)
        created.push(agentId)
      }
    }
  }

  if (created.length > 0) {
    await writeWebSubchannels(existing)
    console.log(`atlas: created ${created.length} research channels: ${created.join(', ')}`)
  }

  return created
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

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
    const deptId = deptChannelId(dept.name)
    if (!existingIds.has(deptId)) {
      const ch: WebChannel = {
        id: deptId,
        label: `Research: ${capitalize(dept.name)}`,
        systemPrompt: `You are the ${capitalize(dept.name)} research department coordinator. You summarize and discuss the latest research analysis from the team's agents. When users ask questions, provide context from recent agent analyses.`,
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

      const agentId = agentChannelId(dept.name, agent.name)
      if (!existingIds.has(agentId)) {
        const ch: WebChannel = {
          id: agentId,
          label: agent.display_name ?? agent.name,
          systemPrompt: `You are ${agent.display_name ?? agent.name}, a specialized research analyst in the ${capitalize(dept.name)} department. Your role: ${agent.name}. Respond based on your analytical expertise. Layer: ${agent.layer}.`,
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

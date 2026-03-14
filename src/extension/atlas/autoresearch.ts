/**
 * Atlas AutoResearch — Prompt self-evolution engine
 *
 * Ported from ATLAS-Commodity's autoresearch.py.
 * Core loop: find worst agent → analyze failures → LLM generates prompt fix →
 * save current version → apply fix → wait N days → keep or revert.
 */

import { readFile, writeFile, copyFile } from 'fs/promises'
import { resolve, dirname } from 'path'
import { mkdir } from 'fs/promises'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
import type { AtlasConfig, EvolutionEntry, AgentScore } from './types.js'
import { Scorecard } from './scorecard.js'
import { getDepartmentDataDir } from './config.js'
import type { LLMCallFn } from './runner.js'

// ==================== Constants ====================

const COOLDOWN_DAYS = 10
const MAX_LENGTH_DELTA = 0.5
const TEST_DAYS = 5

// ==================== AutoResearch ====================

export class AutoResearch {
  private departmentId: string
  private config: AtlasConfig
  private scorecard: Scorecard
  private llmCall: LLMCallFn
  private log: EvolutionEntry[] = []
  private logFile: string

  constructor(
    departmentId: string,
    config: AtlasConfig,
    scorecard: Scorecard,
    llmCall: LLMCallFn,
  ) {
    this.departmentId = departmentId
    this.config = config
    this.scorecard = scorecard
    this.llmCall = llmCall
    this.logFile = resolve('data/atlas', departmentId, 'state', 'evolution_log.json')
  }

  // ==================== Load / Save ====================

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.logFile, 'utf-8')
      this.log = JSON.parse(raw) as EvolutionEntry[]
    } catch {
      this.log = []
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.logFile), { recursive: true })
    await writeFile(this.logFile, JSON.stringify(this.log, null, 2))
  }

  // ==================== Main Entry ====================

  /**
   * Run one evolution cycle:
   * 1. Check if there's an active experiment → evaluate it
   * 2. If not → find worst agent → generate fix → start new experiment
   */
  async runOnce(): Promise<{
    action: 'evaluated' | 'started' | 'skipped'
    agent?: string
    detail: string
  }> {
    await this.load()

    // Check for active experiment
    const active = this.log.find((e) => e.status === 'testing')
    if (active) {
      return await this.evaluateExperiment(active)
    }

    // Start new experiment
    return await this.startNewExperiment()
  }

  // ==================== Evaluate ====================

  private async evaluateExperiment(
    entry: EvolutionEntry,
  ): Promise<{ action: 'evaluated'; agent: string; detail: string }> {
    const daysSinceStart = this.daysSince(entry.started_at)
    if (daysSinceStart < TEST_DAYS) {
      return {
        action: 'evaluated',
        agent: entry.agent,
        detail: `Experiment in progress: ${daysSinceStart}/${TEST_DAYS} days`,
      }
    }

    // Evaluate: compare Sharpe before and after
    const scores = this.scorecard.getAllScores()
    const agentScore = scores.find((s) => s.agent === entry.agent)
    const sharpeAfter = agentScore?.sharpe ?? 0

    entry.sharpe_after = sharpeAfter
    entry.completed_at = new Date().toISOString()

    if (sharpeAfter > entry.sharpe_before) {
      // Improvement → keep
      entry.status = 'kept'
      await this.save()
      return {
        action: 'evaluated',
        agent: entry.agent,
        detail: `KEPT: Sharpe ${entry.sharpe_before.toFixed(2)} → ${sharpeAfter.toFixed(2)}`,
      }
    } else {
      // No improvement → revert
      entry.status = 'reverted'
      await this.revertPrompt(entry)
      await this.save()
      return {
        action: 'evaluated',
        agent: entry.agent,
        detail: `REVERTED: Sharpe ${entry.sharpe_before.toFixed(2)} → ${sharpeAfter.toFixed(2)}`,
      }
    }
  }

  // ==================== Start New ====================

  private async startNewExperiment(): Promise<{
    action: 'started' | 'skipped'
    agent?: string
    detail: string
  }> {
    const scores = this.scorecard.getAllScores()
    if (scores.length === 0) {
      return { action: 'skipped', detail: 'No scored agents yet' }
    }

    // Find worst agent (lowest Sharpe, not on cooldown)
    const candidates = scores
      .filter((s) => s.scored_signals >= 3)
      .filter((s) => !this.isOnCooldown(s.agent))
      .sort((a, b) => a.sharpe - b.sharpe)

    if (candidates.length === 0) {
      return { action: 'skipped', detail: 'All agents on cooldown or insufficient data' }
    }

    const worst = candidates[0]
    const promptFile = await this.findPromptFile(worst.agent)
    if (!promptFile) {
      return { action: 'skipped', detail: `Prompt file not found for ${worst.agent}` }
    }

    // Read current prompt
    const currentPrompt = await readFile(promptFile, 'utf-8')
    const currentHash = this.hash(currentPrompt)

    // Backup current prompt (file copy + git snapshot)
    const backupFile = promptFile + '.backup'
    await copyFile(promptFile, backupFile)
    await this.gitSnapshot(promptFile, `backup: ${worst.agent} before evolution (Sharpe=${worst.sharpe.toFixed(2)})`)

    // Generate improved prompt via LLM
    const newPrompt = await this.generateImprovedPrompt(worst, currentPrompt)
    if (!newPrompt) {
      return { action: 'skipped', agent: worst.agent, detail: 'LLM failed to generate improvement' }
    }

    // Validate length delta
    const lengthRatio = Math.abs(newPrompt.length - currentPrompt.length) / currentPrompt.length
    if (lengthRatio > MAX_LENGTH_DELTA) {
      return {
        action: 'skipped',
        agent: worst.agent,
        detail: `New prompt length differs by ${(lengthRatio * 100).toFixed(0)}% (max ${MAX_LENGTH_DELTA * 100}%)`,
      }
    }

    // Apply new prompt + git snapshot
    await writeFile(promptFile, newPrompt)
    await this.gitSnapshot(promptFile, `evolve: ${worst.agent} — new prompt (Sharpe=${worst.sharpe.toFixed(2)})`)

    // Log experiment
    const entry: EvolutionEntry = {
      agent: worst.agent,
      department: this.departmentId,
      old_prompt_hash: currentHash,
      new_prompt_hash: this.hash(newPrompt),
      reason: `Worst Sharpe: ${worst.sharpe.toFixed(2)}, Win rate: ${worst.win_rate}%`,
      started_at: new Date().toISOString(),
      status: 'testing',
      sharpe_before: worst.sharpe,
    }
    this.log.push(entry)
    await this.save()

    return {
      action: 'started',
      agent: worst.agent,
      detail: `Started experiment: Sharpe=${worst.sharpe.toFixed(2)}, testing for ${TEST_DAYS} days`,
    }
  }

  // ==================== LLM Prompt Generation ====================

  private async generateImprovedPrompt(
    agent: AgentScore,
    currentPrompt: string,
  ): Promise<string | null> {
    const meta = `
You are an AI prompt engineer. An agent named "${agent.agent}" has poor performance:
- Sharpe ratio: ${agent.sharpe.toFixed(2)}
- Win rate: ${agent.win_rate}%
- Average conviction: ${agent.avg_conviction}
- Total signals: ${agent.total_signals}

Analyze the current prompt and suggest improvements.
Keep the same structure and role, but refine the analysis framework.
Do NOT change the output JSON format requirements.
Return ONLY the improved prompt text, nothing else.

Current prompt:
---
${currentPrompt}
---
`.trim()

    try {
      const response = await this.llmCall(meta, 'default')
      const cleaned = response.trim()
      if (cleaned.length < 50) return null
      return cleaned
    } catch {
      return null
    }
  }

  // ==================== Revert ====================

  private async revertPrompt(entry: EvolutionEntry): Promise<void> {
    const promptFile = await this.findPromptFile(entry.agent)
    if (!promptFile) return

    const backupFile = promptFile + '.backup'
    try {
      await copyFile(backupFile, promptFile)
      await this.gitSnapshot(promptFile, `revert: ${entry.agent} — Sharpe did not improve (${entry.sharpe_before.toFixed(2)} → ${entry.sharpe_after?.toFixed(2) ?? '?'})`)
    } catch {
      console.warn(`atlas: failed to revert prompt for ${entry.agent}`)
    }
  }

  // ==================== Helpers ====================

  private isOnCooldown(agentName: string): boolean {
    const lastExperiment = [...this.log]
      .reverse()
      .find((e) => e.agent === agentName && e.status !== 'testing')

    if (!lastExperiment?.completed_at) return false
    return this.daysSince(lastExperiment.completed_at) < COOLDOWN_DAYS
  }

  private daysSince(dateStr: string): number {
    return (Date.now() - new Date(dateStr).getTime()) / (24 * 60 * 60 * 1000)
  }

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 12)
  }

  private async findPromptFile(agentName: string): Promise<string | null> {
    const dataDir = getDepartmentDataDir(this.departmentId)

    // First: try to find prompt_file from agent config (authoritative source)
    try {
      const dept = this.config.departments.find((d) => d.id === this.departmentId)
      if (dept) {
        const { loadDepartmentAgents } = await import('./config.js')
        const agents = await loadDepartmentAgents(dept)
        const agent = agents.find((a) => a.name === agentName)
        if (agent?.prompt_file) {
          const fullPath = resolve(dataDir, agent.prompt_file)
          try {
            await readFile(fullPath, 'utf-8')
            return fullPath
          } catch { /* file doesn't exist at configured path, fall through */ }
        }
      }
    } catch { /* config load failed, fall through to guessing */ }

    // Fallback: try common naming patterns
    const patterns = [
      `prompts/l1_${agentName}.md`,
      `prompts/l2_${agentName}.md`,
      `prompts/l3_${agentName}.md`,
      `prompts/l4_${agentName}.md`,
    ]

    for (const pattern of patterns) {
      const fullPath = resolve(dataDir, pattern)
      try {
        await readFile(fullPath, 'utf-8')
        return fullPath
      } catch {
        continue
      }
    }
    return null
  }

  /** Get evolution history. */
  getLog(): EvolutionEntry[] {
    return [...this.log]
  }
}

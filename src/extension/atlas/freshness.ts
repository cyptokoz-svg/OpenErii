/**
 * Freshness Tracker — Hash-based incremental execution
 *
 * Ported from ATLAS-Commodity's freshness_tracker.py.
 *
 * - Slow data sources (FRED, EIA, CFTC, BIS): SHA256 hash content,
 *   skip agent LLM call if hash unchanged → serve cached Envelope.
 * - Real-time sources (price, news): always re-run.
 * - Envelope caching: save/load agent output JSON to disk.
 */

import { createHash } from 'crypto'
import { readFile, writeFile, mkdir, unlink, readdir } from 'fs/promises'
import { resolve, join } from 'path'
import type { Envelope } from './types.js'

// ==================== Constants ====================

const STATE_DIR = resolve('data/atlas/state')
const FRESHNESS_FILE = join(STATE_DIR, 'data_freshness.json')

/** Real-time sources: always re-run, never skip via hash.
 *  Price/yfinance removed — use data hash comparison instead to avoid
 *  wasting LLM calls when prices barely moved. */
const ALWAYS_REALTIME = new Set([
  'news', 'rss', 'gdelt',             // news is always fresh
  'twitter', 'telegram',              // social media
  'natural_events', 'maritime',       // risk events
  'climate', 'weather',               // weather daily
  'fear_greed',                       // sentiment daily
])

/** Minimum price change (%) to trigger agent rerun. 1% = filter out noise for commodities. */
const PRICE_CHANGE_THRESHOLD = 0.01

/** Extract Close= values from formatted price context string. */
function extractCloseValues(dataContext: string): Record<string, number> | null {
  const matches = dataContext.matchAll(/\*\*(.+?)\*\*: Close=(\d+\.?\d*)/g)
  const result: Record<string, number> = {}
  let count = 0
  for (const m of matches) {
    result[m[1]] = parseFloat(m[2])
    count++
  }
  return count > 0 ? result : null
}

/** Compute max absolute % change between two price snapshots. */
function computeMaxPriceChange(
  prev: Record<string, number>,
  current: Record<string, number>,
): number {
  let maxChange = 0
  for (const [key, curPrice] of Object.entries(current)) {
    const prevPrice = prev[key]
    if (prevPrice && prevPrice > 0) {
      const change = Math.abs(curPrice - prevPrice) / prevPrice
      if (change > maxChange) maxChange = change
    }
  }
  return maxChange
}

// ==================== FreshnessTracker ====================

export class FreshnessTracker {
  private state: Record<string, string> = {}
  private cacheDir: string
  private loaded = false

  constructor(departmentId: string) {
    this.cacheDir = resolve('data/atlas', departmentId, 'envelope_cache')
  }

  /** Load state from disk */
  async init(): Promise<void> {
    if (this.loaded) return
    await mkdir(STATE_DIR, { recursive: true })
    await mkdir(this.cacheDir, { recursive: true })
    try {
      const raw = await readFile(FRESHNESS_FILE, 'utf-8')
      this.state = JSON.parse(raw)
    } catch {
      this.state = {}
    }
    this.loaded = true
  }

  // ==================== Source Hash Management ====================

  /** Compute SHA256 hash (first 16 hex chars) */
  computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  /** Check if a data source has changed since last run */
  isSourceChanged(source: string, newHash: string): boolean {
    // Real-time sources always "changed"
    if (ALWAYS_REALTIME.has(source)) return true
    const oldHash = this.state[`source:${source}`] ?? ''
    return oldHash !== newHash
  }

  /** Update source hash */
  updateSource(source: string, newHash: string): void {
    this.state[`source:${source}`] = newHash
  }

  /** Batch update all source hashes + persist */
  async markSourcesSeen(sourceHashes: Record<string, string>): Promise<void> {
    for (const [source, hash] of Object.entries(sourceHashes)) {
      if (!ALWAYS_REALTIME.has(source)) {
        this.state[`source:${source}`] = hash
      }
    }
    await this.saveState()
  }

  // ==================== Agent Rerun Decision ====================

  /**
   * Should this agent re-run LLM?
   *
   * - If agent has ANY real-time source → yes
   * - If agent's slow sources ALL have same hash → no (serve cache)
   * - If no data sources → yes (L3/L4 depend on upstream)
   */
  shouldAgentRerun(
    agentName: string,
    dataSources: Array<{ provider: string; type: string }>,
    sourceHashes: Record<string, string>,
  ): boolean {
    if (dataSources.length === 0) return true // L3/L4

    for (const source of dataSources) {
      const key = source.provider || source.type
      if (ALWAYS_REALTIME.has(key)) return true
      const newHash = sourceHashes[key] ?? ''
      if (this.isSourceChanged(key, newHash)) return true
    }

    console.log(`atlas: ${agentName} — all sources unchanged → using cached envelope`)
    return false
  }

  // ==================== Agent-level Data Hash ====================

  /**
   * Check if agent should rerun using the actual fetched data context.
   *
   * - If no data sources → always rerun (L3/L4 depend on upstream synthesis)
   * - If agent has news source → always rerun
   * - If agent has price source → only rerun if prices moved > PRICE_CHANGE_THRESHOLD
   * - Otherwise hash compare for slow sources (FRED, etc.)
   */
  shouldAgentRerunWithData(
    agentName: string,
    dataSources: Array<{ provider: string; type: string }>,
    dataContext: string,
  ): boolean {
    if (dataSources.length === 0) return true // L3/L4 depend on upstream

    // Any real-time source (news, social) → always rerun
    for (const source of dataSources) {
      const key = source.provider || source.type
      if (ALWAYS_REALTIME.has(key)) return true
    }

    // Price sources: compare Close values, only rerun if moved > threshold
    const hasPrice = dataSources.some((s) => s.type === 'price')
    if (hasPrice) {
      const stateKey = `agent-prices:${agentName}`
      const currentPrices = extractCloseValues(dataContext)
      const prevPricesStr = this.state[stateKey]

      if (prevPricesStr && currentPrices) {
        try {
          const prevPrices = JSON.parse(prevPricesStr) as Record<string, number>
          const maxChange = computeMaxPriceChange(prevPrices, currentPrices)
          if (maxChange < PRICE_CHANGE_THRESHOLD) {
            console.log(`atlas: ${agentName} — prices moved only ${(maxChange * 100).toFixed(2)}% → using cached envelope`)
            return false
          }
        } catch {
          // Corrupted cache — treat as data changed, re-run agent
        }
      }

      // Store current prices for next comparison
      if (currentPrices) {
        this.state[stateKey] = JSON.stringify(currentPrices)
      }
      return true
    }

    // Slow sources: hash the full data context
    const hash = this.computeHash(dataContext)
    const stateKey = `agent-ctx:${agentName}`
    if (!this.isSourceChanged(stateKey, hash)) {
      console.log(`atlas: ${agentName} — data unchanged → using cached envelope`)
      return false
    }

    return true
  }

  /** Update stored hash after agent runs successfully. */
  markAgentDataSeen(agentName: string, dataContext: string): void {
    const hash = this.computeHash(dataContext)
    this.state[`agent-ctx:${agentName}`] = hash
  }

  /** Persist all state to disk (hashes + agent context hashes). */
  async persistState(): Promise<void> {
    await this.saveState()
  }

  // ==================== Envelope Cache ====================

  /** Save agent envelope to cache */
  async saveEnvelope(agentName: string, envelope: Envelope): Promise<void> {
    const path = join(this.cacheDir, `${agentName}.json`)
    await writeFile(path, JSON.stringify(envelope, null, 2))
  }

  /** Load cached envelope, returns null if missing/invalid */
  async loadEnvelope(agentName: string): Promise<Envelope | null> {
    const path = join(this.cacheDir, `${agentName}.json`)
    try {
      const raw = await readFile(path, 'utf-8')
      const data = JSON.parse(raw) as Envelope
      // Mark as from cache
      ;(data as any)._from_cache = true
      return data
    } catch {
      return null
    }
  }

  /** Clear cache for one agent or all */
  async clearCache(agentName?: string): Promise<void> {
    if (agentName) {
      try {
        await unlink(join(this.cacheDir, `${agentName}.json`))
      } catch { /* ignore */ }
    } else {
      try {
        const files = await readdir(this.cacheDir)
        await Promise.all(
          files.filter((f) => f.endsWith('.json')).map((f) => unlink(join(this.cacheDir, f))),
        )
      } catch { /* ignore */ }
    }
  }

  // ==================== Internal ====================

  private async saveState(): Promise<void> {
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(FRESHNESS_FILE, JSON.stringify(this.state, null, 2))
  }
}

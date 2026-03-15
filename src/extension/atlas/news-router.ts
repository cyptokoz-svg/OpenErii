/**
 * News Router — Rule-first + AI fallback classification & multi-layer routing
 *
 * Ported from ATLAS-Commodity's news_router.py.
 *
 * Flow:
 *   1. Collect news items from various sources (RSS, GDELT, Finnhub, etc.)
 *   2. Tag each item using rule-based keyword matching (fast, free)
 *   3. If confidence < 0.6 → AI fallback classification (haiku, budget-limited)
 *   4. Route tagged items to layers:
 *      - L1: ALL news (macro overview)
 *      - L2: Desk-specific (energy_desk, precious_metals, etc.) — only high-confidence
 *      - L3: Risk/events only (geopolitics, shipping, natural_disaster)
 */

import { readFile } from 'fs/promises'
import { resolve } from 'path'
import { parse as parseYaml } from 'yaml'
import type { LLMCallFn } from './runner.js'

// ==================== Semantic Tags ====================

export const TAG_ENERGY = 'energy'
export const TAG_PRECIOUS = 'precious_metals'
export const TAG_INDUSTRIAL = 'industrial_metals'
export const TAG_AGRI = 'agriculture'
export const TAG_SOFT = 'soft_commodities'
export const TAG_LIVESTOCK = 'livestock'
export const TAG_CARBON = 'carbon_esg'
export const TAG_MACRO = 'macro'
export const TAG_GEO = 'geopolitics'
export const TAG_SHIP = 'shipping'
export const TAG_DISASTER = 'natural_disaster'

export const ALL_TAGS = [
  TAG_ENERGY, TAG_PRECIOUS, TAG_INDUSTRIAL, TAG_AGRI, TAG_SOFT,
  TAG_LIVESTOCK, TAG_CARBON, TAG_MACRO, TAG_GEO, TAG_SHIP, TAG_DISASTER,
] as const

export type NewsTag = typeof ALL_TAGS[number]

/** L2 desk mapping: tag → desk name */
export const TAG_TO_DESK: Partial<Record<NewsTag, string>> = {
  [TAG_ENERGY]: 'energy_desk',
  [TAG_PRECIOUS]: 'precious_metals',
  [TAG_INDUSTRIAL]: 'industrial_metals',
  [TAG_AGRI]: 'agriculture',
  [TAG_SOFT]: 'soft_commodities',
  [TAG_LIVESTOCK]: 'livestock',
  [TAG_CARBON]: 'carbon_esg',
}

// ==================== Tagged News Item ====================

export interface TaggedNewsItem {
  title: string
  summary: string
  source: string
  published_at: string
  origin: string
  tags: NewsTag[]
  confidence: number
}

export interface LayerRouting {
  L1: TaggedNewsItem[]
  L2: Record<string, TaggedNewsItem[]>
  L3: TaggedNewsItem[]
}

// ==================== Keyword Loading ====================

/** Fallback keywords if config file is missing */
const FALLBACK_KEYWORDS: Record<NewsTag, string[]> = {
  [TAG_ENERGY]: ['oil', 'crude', 'brent', 'wti', 'opec', 'gas', 'lng'],
  [TAG_PRECIOUS]: ['gold', 'silver', 'platinum', 'palladium'],
  [TAG_INDUSTRIAL]: ['copper', 'aluminum', 'aluminium', 'zinc', 'nickel', 'iron ore', 'steel'],
  [TAG_AGRI]: ['wheat', 'corn', 'soy', 'soybean', 'grain', 'crop', 'usda'],
  [TAG_SOFT]: ['coffee', 'cocoa', 'sugar', 'cotton'],
  [TAG_LIVESTOCK]: ['cattle', 'hog', 'livestock'],
  [TAG_CARBON]: ['carbon', 'eua', 'ets', 'emissions', 'esg'],
  [TAG_MACRO]: ['fed', 'fomc', 'cpi', 'ppi', 'inflation', 'rates', 'yield', 'dollar'],
  [TAG_GEO]: ['sanction', 'war', 'conflict', 'military', 'strike', 'attack'],
  [TAG_SHIP]: ['shipping', 'freight', 'tanker', 'port', 'canal', 'logistics'],
  [TAG_DISASTER]: ['earthquake', 'hurricane', 'flood', 'wildfire', 'storm'],
}

async function loadKeywords(): Promise<Record<string, string[]>> {
  const configPath = resolve('data/config/news-tags.yaml')
  try {
    const raw = await readFile(configPath, 'utf-8')
    const data = parseYaml(raw) as { tags?: Record<string, string[]> }
    const tags = data?.tags ?? {}
    const out: Record<string, string[]> = {}
    for (const [key, words] of Object.entries(tags)) {
      if (ALL_TAGS.includes(key as NewsTag) && Array.isArray(words)) {
        out[key] = words.map((w) => String(w).toLowerCase())
      }
    }
    return Object.keys(out).length > 0 ? out : { ...FALLBACK_KEYWORDS }
  } catch {
    return { ...FALLBACK_KEYWORDS }
  }
}

// ==================== Rule-based Tagging ====================

function normalizeText(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function ruleTags(
  title: string,
  summary: string,
  sourceHint: string,
  keywords: Record<string, string[]>,
): { tags: NewsTag[]; confidence: number } {
  const text = normalizeText(`${title} ${summary} ${sourceHint}`)
  const scores: Record<string, number> = {}

  for (const [tag, words] of Object.entries(keywords)) {
    for (const w of words) {
      if (text.includes(w)) {
        scores[tag] = (scores[tag] ?? 0) + 1
      }
    }
  }

  const entries = Object.entries(scores)
  if (entries.length === 0) return { tags: [], confidence: 0 }

  const maxScore = Math.max(...entries.map(([, s]) => s))
  const tags = entries
    .filter(([, s]) => s >= maxScore)
    .map(([t]) => t as NewsTag)
  const confidence = Math.min(1.0, maxScore / 3.0)

  return { tags, confidence }
}

// ==================== NewsRouter ====================

export class NewsRouter {
  private keywords: Record<string, string[]> = {}
  private keywordsLoaded = false
  private llmCall?: LLMCallFn
  private aiEnabled: boolean
  private aiLimit: number
  private aiUsed = 0

  constructor(opts?: { llmCall?: LLMCallFn; aiEnabled?: boolean; aiLimit?: number }) {
    this.llmCall = opts?.llmCall
    this.aiEnabled = opts?.aiEnabled ?? false
    this.aiLimit = opts?.aiLimit ?? 10
  }

  /** Load keyword config (lazy, once) */
  private async ensureKeywords(): Promise<void> {
    if (this.keywordsLoaded) return
    this.keywords = await loadKeywords()
    this.keywordsLoaded = true
  }

  // ==================== AI Fallback ====================

  private async aiClassify(
    title: string,
    summary: string,
  ): Promise<{ tags: NewsTag[]; confidence: number } | null> {
    if (!this.aiEnabled || !this.llmCall || this.aiUsed >= this.aiLimit) return null

    const prompt =
      `You are a news router. Given a headline and summary, output the most relevant tags (can be multiple) and confidence (0-1).\n` +
      `Allowed tags: ${ALL_TAGS.join(', ')}\n` +
      `Output ONLY valid JSON: {"tags": [...], "confidence": 0.0}\n\n` +
      `Title: ${title}\nSummary: ${summary}`

    try {
      const response = await this.llmCall(prompt, 'haiku')
      this.aiUsed++

      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0]) as { tags?: string[]; confidence?: number }
      const tags = (parsed.tags ?? []).filter((t): t is NewsTag =>
        ALL_TAGS.includes(t as NewsTag),
      )
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))

      return tags.length > 0 ? { tags, confidence } : null
    } catch {
      return null
    }
  }

  // ==================== Normalize & Tag ====================

  /** Tag a single news item: rule-first, AI fallback if low confidence */
  async tagItem(
    title: string,
    summary: string,
    source: string,
    publishedAt: string,
    origin: string,
    sourceHint = '',
  ): Promise<TaggedNewsItem> {
    await this.ensureKeywords()

    let { tags, confidence } = ruleTags(title, summary, sourceHint, this.keywords)

    // AI fallback when rule confidence is low
    if (confidence < 0.6) {
      const ai = await this.aiClassify(title, summary)
      if (ai) {
        tags = ai.tags
        confidence = ai.confidence
      }
    }

    return {
      title: (title || '').trim() || '(no title)',
      summary: (summary || '').trim(),
      source,
      published_at: publishedAt,
      origin,
      tags,
      confidence,
    }
  }

  // ==================== Batch Processing ====================

  /** Tag a batch of raw news items */
  async tagBatch(
    items: Array<{
      title: string
      summary: string
      source: string
      publishedAt: string
      origin: string
      sourceHint?: string
    }>,
  ): Promise<TaggedNewsItem[]> {
    this.aiUsed = 0 // Reset AI budget per batch
    const tagged: TaggedNewsItem[] = []
    for (const item of items) {
      tagged.push(
        await this.tagItem(
          item.title, item.summary, item.source,
          item.publishedAt, item.origin, item.sourceHint,
        ),
      )
    }
    return tagged
  }

  // ==================== Layer Routing ====================

  /**
   * Split tagged items into layers:
   * - L1: ALL items (macro overview for L1 agents)
   * - L2: Desk-specific, only high-confidence (≥0.6) items
   * - L3: Risk/events only (geopolitics, shipping, natural_disaster)
   */
  splitByLayer(items: TaggedNewsItem[]): LayerRouting {
    const l2: Record<string, TaggedNewsItem[]> = {}
    for (const desk of Object.values(TAG_TO_DESK)) {
      l2[desk] = []
    }
    const l3: TaggedNewsItem[] = []

    for (const item of items) {
      // L3: risk/event tags
      if (
        item.tags.some((t) => t === TAG_GEO || t === TAG_SHIP || t === TAG_DISASTER) ||
        item.origin.includes('gdelt-conflict')
      ) {
        l3.push(item)
      }

      // L2: high-confidence desk routing
      if (item.confidence >= 0.6) {
        for (const tag of item.tags) {
          const desk = TAG_TO_DESK[tag]
          if (desk) l2[desk].push(item)
        }
      }
    }

    return { L1: items, L2: l2, L3: l3 }
  }

  // ==================== Text Rendering ====================

  /** Render tagged items as text for agent prompts */
  static toText(title: string, items: TaggedNewsItem[], limit = 10): string {
    const lines = [`# ${title}`]
    if (items.length === 0) {
      lines.push('(none)')
      return lines.join('\n')
    }
    for (let i = 0; i < Math.min(items.length, limit); i++) {
      const it = items[i]
      const tags = it.tags.slice(0, 3).join(',')
      lines.push(`${i + 1}. ${it.title} [${it.source}] ${it.published_at}`.trim())
      if (it.summary) lines.push(`   ${it.summary}`)
      if (tags) lines.push(`   tags: ${tags} | conf: ${it.confidence.toFixed(2)}`)
    }
    return lines.join('\n')
  }

  // ==================== Integration with NewsCollector ====================

  /**
   * Convert NewsCollector records to tagged items.
   * Bridge between the existing flat collector and the routing system.
   */
  async tagFromCollector(
    records: Array<{
      title: string
      content: string
      metadata: Record<string, string | null>
      pubTs?: number
    }>,
  ): Promise<TaggedNewsItem[]> {
    const items = records.map((r) => ({
      title: r.title,
      summary: (r.content || '').slice(0, 240),
      source: r.metadata.source ?? 'unknown',
      publishedAt: r.pubTs
        ? new Date(r.pubTs).toISOString().slice(0, 19)
        : '',
      origin: r.metadata.ingestSource ?? 'rss',
      sourceHint: r.metadata.categories ?? '',
    }))
    return this.tagBatch(items)
  }
}

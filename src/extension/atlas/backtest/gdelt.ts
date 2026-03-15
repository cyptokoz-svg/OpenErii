/**
 * GDELT Historical News Fetcher
 *
 * Uses the GDELT DOC 2.0 API to fetch historical news articles by date.
 * For dates older than ~3 months, falls back to BigQuery (full GDELT archive from 2015).
 * Pre-downloads news for the backtest date range, caches to local JSON.
 * Rate limited to 1 req/sec per GDELT guidelines.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { resolve } from 'path'
import type { GdeltArticle, GdeltDayCache } from './types.js'
import { GdeltBigQuery } from './gdelt-bigquery.js'

// ==================== Constants ====================

const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc'
const DEFAULT_KEYWORDS = 'commodity OR crude oil OR gold OR wheat OR natural gas OR copper OR agriculture'
const MAX_RECORDS = 100
const RATE_LIMIT_MS = 1100 // >1 second between requests
const DOC_API_HORIZON_DAYS = 85 // DOC 2.0 API only covers ~3 months

// ==================== GDELT Fetcher ====================

export class GdeltFetcher {
  private cacheDir: string
  private keywords: string
  private bigquery: GdeltBigQuery | null = null

  constructor(departmentId: string, keywords?: string, bigqueryProject?: string) {
    this.cacheDir = resolve('data/atlas', departmentId, 'backtest/historical/news')
    this.keywords = keywords ?? DEFAULT_KEYWORDS
    const project = bigqueryProject ?? process.env.GCLOUD_PROJECT
    if (project) {
      this.bigquery = new GdeltBigQuery(project)
    }
  }

  /**
   * Download GDELT news for a date range. Skips dates already cached.
   * Automatically uses BigQuery for dates beyond DOC 2.0 API's ~3 month horizon.
   * Returns the number of new dates downloaded.
   */
  async download(
    startDate: string,
    endDate: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    await mkdir(this.cacheDir, { recursive: true })

    const dates = this.calendarDays(startDate, endDate)
    const existing = await this.cachedDates()
    const missing = dates.filter((d) => !existing.has(d))

    if (missing.length === 0) return 0

    // Split into DOC API dates (recent) and BigQuery dates (old)
    const cutoff = subtractDays(new Date().toISOString().slice(0, 10), DOC_API_HORIZON_DAYS)
    const bqDates = missing.filter((d) => d < cutoff)
    const apiDates = missing.filter((d) => d >= cutoff)

    if (bqDates.length > 0 && !this.bigquery) {
      console.warn(
        `gdelt: ${bqDates.length} dates are older than ${DOC_API_HORIZON_DAYS} days and require BigQuery.\n` +
        `Set GCLOUD_PROJECT env var or pass bigqueryProject to enable. These dates will have no news.`,
      )
    }

    let downloaded = 0
    const total = missing.length

    // Fetch old dates via BigQuery (batch-friendly, no rate limit needed)
    if (bqDates.length > 0 && this.bigquery) {
      console.log(`gdelt: fetching ${bqDates.length} historical dates via BigQuery`)
      for (const date of bqDates) {
        try {
          const articles = await this.bigquery.fetchDay(date, MAX_RECORDS)
          const cache: GdeltDayCache = {
            date,
            articles,
            fetched_at: new Date().toISOString(),
            source: 'bigquery',
          }
          await writeFile(resolve(this.cacheDir, `${date}.json`), JSON.stringify(cache))
          downloaded++
          onProgress?.(downloaded, total)
        } catch (err) {
          console.warn(`gdelt-bq: failed to fetch ${date}:`, err)
          const empty: GdeltDayCache = { date, articles: [], fetched_at: new Date().toISOString(), source: 'bigquery' }
          await writeFile(resolve(this.cacheDir, `${date}.json`), JSON.stringify(empty))
          downloaded++
          onProgress?.(downloaded, total)
        }
      }
    } else if (bqDates.length > 0) {
      // No BigQuery available — write empty caches for old dates
      for (const date of bqDates) {
        const empty: GdeltDayCache = { date, articles: [], fetched_at: new Date().toISOString(), source: 'unavailable' }
        await writeFile(resolve(this.cacheDir, `${date}.json`), JSON.stringify(empty))
        downloaded++
        onProgress?.(downloaded, total)
      }
    }

    // Fetch recent dates via DOC 2.0 API (rate limited)
    for (const date of apiDates) {
      try {
        const articles = await this.fetchDayAPI(date)
        const cache: GdeltDayCache = {
          date,
          articles,
          fetched_at: new Date().toISOString(),
          source: 'doc_api',
        }
        await writeFile(resolve(this.cacheDir, `${date}.json`), JSON.stringify(cache))
        downloaded++
        onProgress?.(downloaded, total)
        await sleep(RATE_LIMIT_MS)
      } catch (err) {
        console.warn(`gdelt: failed to fetch ${date}:`, err)
        const empty: GdeltDayCache = { date, articles: [], fetched_at: new Date().toISOString(), source: 'doc_api' }
        await writeFile(resolve(this.cacheDir, `${date}.json`), JSON.stringify(empty))
        downloaded++
        onProgress?.(downloaded, total)
        await sleep(RATE_LIMIT_MS)
      }
    }

    return downloaded
  }

  /**
   * Read cached news for a specific date.
   * Returns formatted markdown context for agents.
   */
  async readForDate(date: string): Promise<string> {
    const filePath = resolve(this.cacheDir, `${date}.json`)
    try {
      const raw = await readFile(filePath, 'utf-8')
      const cache = JSON.parse(raw) as GdeltDayCache
      if (cache.articles.length === 0) {
        return '### Historical News\nNo news data available for this date.'
      }
      return this.formatArticles(cache.articles, date)
    } catch {
      return '### Historical News\nNo cached news for this date.'
    }
  }

  /**
   * Read accumulated news context up to a date (last 3 days of news).
   */
  async readContextUpTo(date: string): Promise<string> {
    const parts: string[] = []

    for (let i = 0; i < 3; i++) {
      const checkDate = subtractDays(date, i)
      const filePath = resolve(this.cacheDir, `${checkDate}.json`)
      try {
        const raw = await readFile(filePath, 'utf-8')
        const cache = JSON.parse(raw) as GdeltDayCache
        if (cache.articles.length > 0) {
          parts.push(...cache.articles.slice(0, 10).map((a) =>
            `- [${checkDate}] ${a.title} (${a.source}, tone: ${a.tone?.toFixed(1) ?? 'n/a'})`,
          ))
        }
      } catch {
        // No cache for this date
      }
    }

    if (parts.length === 0) {
      return '### Historical News\nNo news data available.'
    }

    return `### Historical News (up to ${date})\n${parts.join('\n')}`
  }

  /**
   * Get raw articles up to a date (last 3 days) for NewsRouter tagging.
   */
  async getArticlesUpTo(date: string): Promise<Array<GdeltArticle & { date: string }>> {
    const articles: Array<GdeltArticle & { date: string }> = []

    for (let i = 0; i < 3; i++) {
      const checkDate = subtractDays(date, i)
      const filePath = resolve(this.cacheDir, `${checkDate}.json`)
      try {
        const raw = await readFile(filePath, 'utf-8')
        const cache = JSON.parse(raw) as GdeltDayCache
        for (const a of cache.articles.slice(0, 15)) {
          articles.push({ ...a, date: checkDate })
        }
      } catch {
        // No cache for this date
      }
    }

    return articles
  }

  // ==================== Private ====================

  /** Fetch via GDELT DOC 2.0 REST API (recent dates only) */
  private async fetchDayAPI(date: string): Promise<GdeltArticle[]> {
    const start = date.replace(/-/g, '') + '000000'
    const end = date.replace(/-/g, '') + '235959'

    const params = new URLSearchParams({
      query: this.keywords,
      mode: 'artlist',
      startdatetime: start,
      enddatetime: end,
      maxrecords: String(MAX_RECORDS),
      format: 'json',
    })

    const url = `${GDELT_BASE}?${params.toString()}`
    const res = await fetch(url)

    if (!res.ok) {
      throw new Error(`GDELT API error: ${res.status} ${res.statusText}`)
    }

    const data = await res.json() as { articles?: Array<{
      title?: string
      url?: string
      source?: string
      language?: string
      seendate?: string
      tone?: number
    }> }

    if (!data.articles) return []

    return data.articles.map((a) => ({
      title: a.title ?? '',
      url: a.url ?? '',
      source: a.source ?? '',
      language: a.language ?? '',
      seendate: a.seendate ?? '',
      tone: typeof a.tone === 'number' ? a.tone : 0,
    }))
  }

  private formatArticles(articles: GdeltArticle[], date: string): string {
    const lines = [`### Historical News (${date})`]
    for (const a of articles.slice(0, 20)) {
      const toneStr = a.tone > 1 ? '+' : a.tone < -1 ? '-' : '~'
      lines.push(`- [${toneStr}] ${a.title} (${a.source})`)
    }
    return lines.join('\n')
  }

  private async cachedDates(): Promise<Set<string>> {
    try {
      const files = await readdir(this.cacheDir)
      return new Set(
        files
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace('.json', '')),
      )
    } catch {
      return new Set()
    }
  }

  private calendarDays(startDate: string, endDate: string): string[] {
    const days: string[] = []
    const current = new Date(startDate)
    const end = new Date(endDate)

    while (current <= end) {
      days.push(current.toISOString().slice(0, 10))
      current.setDate(current.getDate() + 1)
    }

    return days
  }
}

/** Timezone-safe date subtraction using pure string arithmetic. */
function subtractDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d - days))
  return dt.toISOString().slice(0, 10)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

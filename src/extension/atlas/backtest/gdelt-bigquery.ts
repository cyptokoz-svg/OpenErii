/**
 * GDELT BigQuery Fetcher — Historical news via Google BigQuery
 *
 * The GDELT DOC 2.0 API only covers the last ~3 months.
 * For older dates, this fetcher queries the full GDELT GKG archive on BigQuery
 * (data from 2015 to present, updated every 15 minutes).
 *
 * V2Themes used as broad domain filter (economics, energy, agriculture, geopolitics, etc.)
 * to exclude irrelevant content (sports, entertainment). Fine-grained classification
 * and desk routing is handled downstream by NewsRouter.
 *
 * Table: gdelt-bq.gdeltv2.gkg_partitioned
 * Free tier: 1 TB/month query processing (one day ≈ 50-200 MB)
 *
 * Auth: requires `gcloud auth application-default login` or GOOGLE_APPLICATION_CREDENTIALS
 */

import type { GdeltArticle } from './types.js'

// ==================== Domain Filter (broad, not classification) ====================

/** Core commodity/macro themes — must match at least one to be included */
const CORE_THEMES = [
  'ENV_OIL', 'ENV_NATURALGAS', 'ENV_COAL',
  'ENV_GOLD', 'ENV_SILVER', 'ENV_MINING',
  'ECON_ENERGY', 'ECON_INFLATION', 'ECON_CENTRALBANK', 'ECON_INTEREST',
  'ECON_CURRENCY', 'ECON_DEBT', 'ECON_TRADE',
  'AGRI', 'ENV_CROPFAILURE', 'ENV_DROUGHT',
  'TRANSPORT_SHIPPING',
]

/** Supplementary themes — add relevance score but not required alone */
const SUPPLEMENTARY_THEMES = [
  'ENV_NUCLEARPOWER', 'ECON_GDP', 'ENV_FOOD',
  'CONFLICT', 'MILITARY', 'DISASTER', 'CRISISLEX',
]

// WHERE: must match at least one core theme
const THEME_WHERE = CORE_THEMES.map((t) => `V2Themes LIKE '%${t}%'`).join(' OR ')

// ORDER BY: relevance = count of matching themes (core=2, supplementary=1)
const RELEVANCE_EXPR = [
  ...CORE_THEMES.map((t) => `IF(V2Themes LIKE '%${t}%', 2, 0)`),
  ...SUPPLEMENTARY_THEMES.map((t) => `IF(V2Themes LIKE '%${t}%', 1, 0)`),
].join(' + ')

// ==================== BigQuery Fetcher ====================

export class GdeltBigQuery {
  private projectId: string
  private client: any | null = null

  constructor(projectId: string) {
    this.projectId = projectId
  }

  /** Lazy-load BigQuery client (avoids import failure if package not installed) */
  private async getClient(): Promise<any> {
    if (this.client) return this.client
    try {
      const { BigQuery } = await import('@google-cloud/bigquery')
      this.client = new BigQuery({ projectId: this.projectId })
      return this.client
    } catch {
      throw new Error(
        'BigQuery client not available. Install: pnpm add @google-cloud/bigquery\n' +
        'Auth: gcloud auth application-default login',
      )
    }
  }

  /**
   * Fetch news for a specific date from GDELT GKG via BigQuery.
   * Broad domain filter only — classification is done by NewsRouter.
   */
  async fetchDay(date: string, maxRecords = 50): Promise<GdeltArticle[]> {
    const client = await this.getClient()

    const query = `
      SELECT
        SourceCommonName AS source,
        DocumentIdentifier AS url,
        V2Themes AS themes,
        SAFE_CAST(SPLIT(V2Tone, ',')[OFFSET(0)] AS FLOAT64) AS tone
      FROM \`gdelt-bq.gdeltv2.gkg_partitioned\`
      WHERE DATE(_PARTITIONTIME) = @date
        AND (${THEME_WHERE})
        AND SourceCommonName IS NOT NULL
        AND DocumentIdentifier IS NOT NULL
        AND (TranslationInfo IS NULL OR TranslationInfo = '')
      ORDER BY (${RELEVANCE_EXPR}) DESC
      LIMIT @limit
    `

    const [rows] = await client.query({
      query,
      params: { date, limit: maxRecords * 4 },
      location: 'US',
    })

    // Deduplicate: URL exact match + title similarity + per-source limit
    const seenUrls = new Set<string>()
    const seenFingerprints = new Set<string>()
    const sourceCounts = new Map<string, number>()
    const articles: GdeltArticle[] = []

    for (const row of rows) {
      if (articles.length >= maxRecords) break
      const url = row.url ?? ''
      const source = row.source ?? ''

      // 1. Exact URL dedup
      if (seenUrls.has(url)) continue
      seenUrls.add(url)

      const title = extractTitle(url, row.themes)
      // Skip articles where title extraction failed
      if (title === '(untitled)') continue

      // 2. Title similarity dedup — same story from different sources
      const fp = titleFingerprint(title)
      if (seenFingerprints.has(fp)) continue
      seenFingerprints.add(fp)

      // 3. Per-source limit (tier-based)
      const limit = getSourceLimit(source)
      const count = sourceCounts.get(source) ?? 0
      if (count >= limit) continue
      sourceCounts.set(source, count + 1)

      articles.push({
        title,
        url,
        source,
        language: 'en',
        seendate: date,
        tone: typeof row.tone === 'number' ? row.tone : 0,
      })
    }

    return articles
  }
}

// ==================== Title Similarity Dedup ====================

/** Stop words removed for fingerprinting */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or',
  'is', 'are', 'was', 'were', 'be', 'by', 'as', 'its', 'it', 'that',
  'with', 'from', 'has', 'have', 'had', 'but', 'not', 'this', 'will',
  'after', 'over', 'into', 'amid', 'says', 'said', 'new', 'may', 'can',
])

/**
 * Generate a fingerprint from title for cross-source dedup.
 * "Fed Holds Rates Steady In June" and "Fed Holds Interest Rates Steady"
 * both produce the same fingerprint → deduplicated.
 *
 * Extracts sorted meaningful words (no stop words, lowercased, first 5).
 */
function titleFingerprint(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .sort()
    .slice(0, 5)
  return words.join('|')
}

// ==================== Source Tier ====================

const TIER1_SOURCES = new Set([
  'reuters.com', 'bloomberg.com', 'bnnbloomberg.ca', 'ft.com',
  'wsj.com', 'cnbc.com', 'yahoo.com', 'marketwatch.com',
  'economist.com', 'imf.org', 'worldbank.org',
])

/** Major outlets get 10 articles, others get 3 */
function getSourceLimit(source: string): number {
  const s = source.toLowerCase()
  return TIER1_SOURCES.has(s) ? 10 : 3
}

// ==================== Title Extraction ====================

/**
 * Extract a readable title from a news article URL.
 * Most news URLs contain the headline as a slug:
 *   https://reuters.com/business/energy/oil-prices-rise-supply-concerns-2024-01-15/
 *   → "Oil Prices Rise Supply Concerns"
 */
function extractTitle(url: string, themes?: string): string {
  try {
    const path = new URL(url).pathname
    const segments = path.split('/').filter(Boolean)

    // Find the longest segment (usually the article slug)
    const slug = segments.reduce((a, b) => (a.length > b.length ? a : b), '')
    if (slug.length > 12) {
      const title = slug
        .replace(/[-_]+/g, ' ')
        .replace(/\.\w+$/, '')           // remove .html etc
        .replace(/\b[a-f0-9]{8,}\b/gi, '') // remove hex/numeric IDs
        .replace(/\b\d{4}[-/]\d{2}[-/]\d{2}\b/g, '') // remove dates
        .trim()

      if (title.length > 10) {
        return title
          .split(' ')
          .filter(Boolean)
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ')
      }
    }
  } catch {
    // Invalid URL, fall through
  }

  // Fallback: construct from GKG themes
  if (themes) {
    const readable = themes
      .split(';')
      .slice(0, 4)
      .map((t) => t.split(',')[0]) // theme format: THEME,offset
      .filter((t) => t && !t.startsWith('TAX_'))
      .map((t) => t.replace(/_/g, ' ').toLowerCase())
    if (readable.length > 0) return readable.join(', ')
  }

  return '(untitled)'
}

/**
 * Atlas Knowledge Graph — Obsidian vault integration
 *
 * Ported from ATLAS-Commodity's knowledge_graph.py (504 lines).
 * Reads/writes Markdown files in an Obsidian vault directory.
 * Features: [[wikilinks]], frontmatter, BFS graph traversal,
 * conflict detection, GC, dedup, permanent memory.
 */

import { readFile, writeFile, readdir, mkdir, stat } from 'fs/promises'
import { resolve, relative, join, basename } from 'path'
import type { KnowledgeUpdate } from './types.js'

// ==================== Constants ====================

/** Concept → link name mapping. Sorted by length desc to prevent short words from eating long ones. */
const CONCEPT_LINK_MAP: Record<string, string> = {
  // Crude oil
  '霍尔木兹': '霍尔木兹', 'WTI原油': 'WTI原油', '布伦特原油': '布伦特原油',
  'OPEC减产': 'OPEC减产', 'OPEC': 'OPEC', 'EIA库存': 'EIA库存',
  // Precious metals
  '黄金避险': '黄金避险', '黄金': '黄金', '白银': '白银', '铂金': '铂金', '钯金': '钯金',
  // Industrial metals
  '铜需求': '铜需求', '铜': '铜', '铝': '铝', '镍': '镍', '锌': '锌',
  // Agriculture
  '大豆油': '大豆油', '豆粕': '豆粕', '大豆': '大豆', '玉米': '玉米',
  '小麦': '小麦', '咖啡': '咖啡', '糖': '糖', '棉花': '棉花',
  // Energy
  '天然气': '天然气', '取暖油': '取暖油', '汽油': '汽油',
  // Macro
  '美联储': '美联储', '美元指数': '美元指数', '实际利率': '实际利率',
  '通胀预期': '通胀预期', 'VIX': 'VIX',
  // Crypto
  'BTC': 'BTC', 'ETH': 'ETH', 'DeFi': 'DeFi',
  // Events
  '俄乌': '俄乌冲突', '中东局势': '中东局势',
}

const PERMANENT_TYPES = new Set(['event', 'lesson'])

const CATEGORY_MAP: Record<string, string> = {
  insight: 'commodities',
  event: 'events',
  lesson: 'agents',
  pattern: 'commodities',
  seasonal: 'seasonal',
}

// ==================== Types ====================

interface NoteInfo {
  file: string
  path: string
  content: string
  stale: boolean
  updated: string
  source: string
}

interface Frontmatter {
  tags?: string[]
  type?: string
  permanent?: string
  created?: string
  updated?: string
  author?: string
  [key: string]: string | string[] | undefined
}

interface GCResult {
  trimmed: number
  archived: number
}

interface KnowledgeStats {
  total_notes: number
  total_size_kb: number
  stale_notes: number
  categories: string[]
}

// ==================== Knowledge Graph ====================

export class KnowledgeGraph {
  private root: string
  private staleDays: number

  constructor(vaultPath: string, staleDays: number = 30) {
    this.root = vaultPath
    this.staleDays = staleDays
  }

  // ==================== Init ====================

  /** Ensure vault directory structure exists. */
  async init(): Promise<void> {
    const dirs = ['agents', 'commodities', 'events', 'seasonal', 'archive']
    for (const dir of dirs) {
      await mkdir(join(this.root, dir), { recursive: true })
    }
  }

  // ==================== Read ====================

  /** Read a single note by filename (searches all subdirectories). */
  async readNote(filename: string): Promise<string | null> {
    const path = await this.findNote(filename)
    if (!path) return null
    try {
      return await readFile(path, 'utf-8')
    } catch {
      return null
    }
  }

  /** Search notes by knowledge_links tags. */
  async readNotesByTags(tags: string[], maxNotes: number = 10): Promise<NoteInfo[]> {
    const results: NoteInfo[] = []
    const files = await this.getAllMarkdownFiles()

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8')
      const fm = parseFrontmatter(content)
      const noteTags = Array.isArray(fm.tags) ? fm.tags : fm.tags ? [fm.tags] : []
      const stem = basename(filePath, '.md').toLowerCase()

      const matched = tags.some(
        (tag) =>
          noteTags.some((t) => (typeof t === 'string' ? t : '').toLowerCase() === tag.toLowerCase()) ||
          stem.includes(tag.toLowerCase()),
      )

      if (matched) {
        results.push({
          file: basename(filePath),
          path: relative(this.root, filePath),
          content,
          stale: this.isStale(fm),
          updated: fm.updated ?? 'unknown',
          source: 'seed',
        })
      }
    }

    results.sort((a, b) => b.updated.localeCompare(a.updated))
    return results.slice(0, maxNotes)
  }

  /**
   * Enhanced retrieval: tag matching + [[wikilink]] BFS traversal.
   * Follows links up to linkDepth layers deep.
   */
  async readNotesWithLinks(
    tags: string[],
    maxNotes: number = 10,
    linkDepth: number = 2,
    maxLinked: number = 6,
  ): Promise<NoteInfo[]> {
    const seeds = await this.readNotesByTags(tags, maxNotes)
    const seen = new Set(seeds.map((n) => n.file))
    const result: NoteInfo[] = seeds.map((n) => ({ ...n, source: 'seed' }))

    if (seeds.length === 0 || linkDepth < 1) return result

    let frontier = seeds
    for (let depth = 1; depth <= linkDepth; depth++) {
      const linkedFiles: string[] = []

      for (const note of frontier) {
        for (const linkName of findLinks(note.content)) {
          const fname = linkName.trim().replace(/ /g, '_') + '.md'
          if (!seen.has(fname)) {
            linkedFiles.push(fname)
            seen.add(fname)
          }
        }
      }

      if (linkedFiles.length === 0) break

      const nextLayer: NoteInfo[] = []
      for (const fname of linkedFiles.slice(0, maxLinked)) {
        const content = await this.readNote(fname)
        if (!content) continue

        const path = await this.findNote(fname)
        const fm = parseFrontmatter(content)
        const entry: NoteInfo = {
          file: fname,
          path: path ? relative(this.root, path) : fname,
          content,
          stale: this.isStale(fm),
          updated: fm.updated ?? 'unknown',
          source: `linked-L${depth}`,
        }
        nextLayer.push(entry)
        result.push(entry)
      }

      frontier = nextLayer
    }

    return result
  }

  // ==================== Write ====================

  /** Write or append a note to the vault. */
  async writeNote(
    filename: string,
    content: string,
    category: string = 'commodities',
    tags: string[] | null = null,
    agentName: string = '',
    noteType: string = 'insight',
  ): Promise<void> {
    // Sanitize filename
    if (!filename.endsWith('.md')) filename += '.md'
    filename = basename(filename)
    if (filename.includes('..')) filename = filename.replace(/\.\./g, '')

    const categoryDir = join(this.root, category)
    await mkdir(categoryDir, { recursive: true })
    const filePath = join(categoryDir, filename)

    const now = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    const linkedContent = injectLinks(content)

    try {
      const existing = await readFile(filePath, 'utf-8')
      await this.appendNote(filePath, existing, linkedContent, agentName, noteType, now)
    } catch {
      await this.createNote(filePath, filename, linkedContent, tags, category, agentName, noteType, now)
    }
  }

  /** Process knowledge_updates from an agent envelope. */
  async writeUpdatesFromEnvelope(agentName: string, updates: KnowledgeUpdate[]): Promise<void> {
    for (const ku of updates) {
      const category = CATEGORY_MAP[ku.type] ?? 'commodities'
      await this.writeNote(ku.file, ku.content, category, null, agentName, ku.type)
    }
  }

  // ==================== GC ====================

  /** Garbage collect: trim stale notes, archive old entries. */
  async gc(maxEntriesPerNote: number = 20, archive: boolean = true): Promise<GCResult> {
    let trimmed = 0
    let archived = 0
    const archiveDir = join(this.root, 'archive')

    const files = await this.getAllMarkdownFiles()
    for (const filePath of files) {
      if (filePath.includes('archive')) continue

      const content = await readFile(filePath, 'utf-8')
      const fm = parseFrontmatter(content)

      if (fm.permanent === 'true') continue
      if (!this.isStale(fm)) continue

      const sections = content.split('\n---\n')
      if (sections.length <= maxEntriesPerNote) continue

      const keep = [sections[0], ...sections.slice(-maxEntriesPerNote)]
      const removed = sections.slice(1, -maxEntriesPerNote)

      if (archive && removed.length > 0) {
        await mkdir(archiveDir, { recursive: true })
        const archivePath = join(archiveDir, basename(filePath))
        const archiveContent = `# Archived from ${basename(filePath)}\n\n${removed.join('\n---\n')}`
        try {
          const existing = await readFile(archivePath, 'utf-8')
          await writeFile(archivePath, existing + '\n---\n' + archiveContent)
        } catch {
          await writeFile(archivePath, archiveContent)
        }
        archived += removed.length
      }

      await writeFile(filePath, keep.join('\n---\n'))
      trimmed += removed.length
    }

    return { trimmed, archived }
  }

  // ==================== Stats ====================

  async stats(): Promise<KnowledgeStats> {
    const files = await this.getAllMarkdownFiles()
    let totalSize = 0
    let staleCount = 0
    const categories = new Set<string>()

    for (const f of files) {
      const s = await stat(f)
      totalSize += s.size
      const content = await readFile(f, 'utf-8')
      const fm = parseFrontmatter(content)
      if (this.isStale(fm)) staleCount++
      const parts = relative(this.root, f).split('/')
      if (parts.length > 1) categories.add(parts[0])
    }

    return {
      total_notes: files.length,
      total_size_kb: Math.round(totalSize / 1024 * 10) / 10,
      stale_notes: staleCount,
      categories: [...categories],
    }
  }

  async listNotes(category?: string): Promise<string[]> {
    const searchRoot = category ? join(this.root, category) : this.root
    const files = await this.getAllMarkdownFiles(searchRoot)
    return files.map((f) => relative(this.root, f))
  }

  // ==================== Format ====================

  formatContext(notes: NoteInfo[]): string {
    if (notes.length === 0) return ''
    return notes
      .map((n) => {
        const staleMark = n.stale ? ' ⚠️stale' : ''
        const sourceLabel = n.source === 'seed' ? '' : ` [${n.source}]`
        return `### ${n.file}${staleMark}${sourceLabel}\n${n.content}`
      })
      .join('\n\n---\n\n')
  }

  // ==================== Private ====================

  private async appendNote(
    path: string,
    existing: string,
    content: string,
    agentName: string,
    noteType: string,
    now: string,
  ): Promise<void> {
    if (isDuplicate(existing, content)) return

    const conflict = detectConflict(existing, content)
    let entry = `\n\n---\n## ${now} by ${agentName} (${noteType})`
    if (conflict) entry += `\n\n⚠️ **Direction conflict**: ${conflict}`
    entry += `\n\n${content}`

    const updated = updateFrontmatterDate(existing, now)
    await writeFile(path, updated + entry)
  }

  private async createNote(
    path: string,
    filename: string,
    content: string,
    tags: string[] | null,
    category: string,
    agentName: string,
    noteType: string,
    now: string,
  ): Promise<void> {
    const tagsStr = tags?.join(', ') ?? category
    const permanent = PERMANENT_TYPES.has(noteType) ? 'permanent: true\n' : ''
    const frontmatter =
      `---\ntags: [${tagsStr}]\ntype: ${noteType}\n${permanent}` +
      `created: ${now}\nupdated: ${now}\nauthor: ${agentName}\n---\n\n`
    const title = filename.replace('.md', '')
    await writeFile(path, frontmatter + `# ${title}\n\n${content}`)
  }

  private async findNote(filename: string): Promise<string | null> {
    if (!filename.endsWith('.md')) filename += '.md'
    const files = await this.getAllMarkdownFiles()
    return files.find((f) => basename(f) === filename) ?? null
  }

  private async getAllMarkdownFiles(root?: string): Promise<string[]> {
    const searchRoot = root ?? this.root
    const results: string[] = []

    async function walk(dir: string) {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (entry.name.endsWith('.md')) {
          results.push(fullPath)
        }
      }
    }

    await walk(searchRoot)
    return results
  }

  private isStale(fm: Frontmatter): boolean {
    const updated = fm.updated
    if (!updated || updated === 'unknown') return true
    try {
      const clean = updated.replace(' UTC', '').replace(' utc', '').trim()
      const dt = new Date(clean)
      if (isNaN(dt.getTime())) return true
      return Date.now() - dt.getTime() > this.staleDays * 24 * 60 * 60 * 1000
    } catch {
      return true
    }
  }
}

// ==================== Pure Functions ====================

export function findLinks(content: string): string[] {
  const matches = content.match(/\[\[([^\]]+)\]\]/g)
  if (!matches) return []
  return matches.map((m) => m.slice(2, -2))
}

export function injectLinks(content: string): string {
  // Stash existing [[links]] to avoid double-wrapping
  const placeholders: string[] = []
  let result = content.replace(/\[\[[^\]]+\]\]/g, (match) => {
    placeholders.push(match)
    return `\x00LINK${placeholders.length - 1}\x00`
  })

  // Sort by length desc to prevent short words from eating long ones
  const sorted = Object.entries(CONCEPT_LINK_MAP).sort((a, b) => b[0].length - a[0].length)
  for (const [word, linkName] of sorted) {
    result = result.replace(word, `[[${linkName}]]`)
  }

  // Restore stashed links
  for (let i = 0; i < placeholders.length; i++) {
    result = result.replace(`\x00LINK${i}\x00`, placeholders[i])
  }

  return result
}

function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith('---')) return {}
  const parts = content.split('---', 3)
  if (parts.length < 3) return {}

  const fm: Frontmatter = {}
  for (const line of parts[1].trim().split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx < 0) continue
    const key = line.slice(0, colonIdx).trim()
    let value = line.slice(colonIdx + 1).trim()

    if (value.startsWith('[') && value.endsWith(']')) {
      fm[key] = value.slice(1, -1).split(',').map((v) => v.trim()).filter(Boolean)
    } else {
      fm[key] = value
    }
  }
  return fm
}

function isDuplicate(existing: string, newContent: string): boolean {
  const normalized = newContent.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 150)
  if (normalized.length < 20) return false
  return existing.toLowerCase().replace(/\s+/g, ' ').includes(normalized)
}

function detectConflict(existing: string, newContent: string): string {
  const tail = existing.slice(-500).toLowerCase()
  const fresh = newContent.toLowerCase()

  const bullishWords = ['bullish', '看多', '利多', '上涨']
  const bearishWords = ['bearish', '看空', '利空', '下跌']

  const existBull = bullishWords.some((w) => tail.includes(w))
  const existBear = bearishWords.some((w) => tail.includes(w))
  const newBull = bullishWords.some((w) => fresh.includes(w))
  const newBear = bearishWords.some((w) => fresh.includes(w))

  if (existBull && newBear) return 'Previous entry was bullish, current is bearish'
  if (existBear && newBull) return 'Previous entry was bearish, current is bullish'
  return ''
}

function updateFrontmatterDate(content: string, newDate: string): string {
  return content.replace(/(updated:\s*)[^\n]+/, `$1${newDate}`)
}

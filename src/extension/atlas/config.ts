/**
 * Atlas Config — Load and validate atlas configuration files
 *
 * Loads departments.json, per-department agents.json, and atlas.json.
 * All validated with Zod schemas. Missing files fall back to defaults.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { resolve } from 'path'
import { z } from 'zod'
import type { AtlasConfig, DepartmentConfig, AgentConfig } from './types.js'

// ==================== Paths ====================

const ATLAS_CONFIG_PATH = resolve('data/config/atlas.json')
const ATLAS_DATA_DIR = resolve('data/atlas')

// ==================== Zod Schemas ====================

const DataSourceSchema = z.object({
  provider: z.string().default(''),
  query: z.string().default(''),
  symbols: z.array(z.string()).optional(),
  type: z.enum(['price', 'news', 'macro', 'equity', 'economy', 'crypto', 'commodity', 'currency']).default('price'),
  /** SDK client method name, e.g. 'getIncomeStatement', 'fredSeries'. */
  method: z.string().optional(),
  /** Params to pass directly to the SDK method. */
  params: z.record(z.string(), z.unknown()).optional(),
})

const AgentConfigSchema = z.object({
  name: z.string(),
  display_name: z.string(),
  layer: z.enum(['L1', 'L2', 'L3', 'L4']),
  model_tier: z.string().default('default'),
  style: z.string().default(''),
  prompt_file: z.string(),
  knowledge_links: z.array(z.string()).default([]),
  data_sources: z.array(DataSourceSchema).default([]),
  rule_based: z.boolean().default(false),
  chat_enabled: z.boolean().default(false),
  enabled: z.boolean().default(true),
})

const DepartmentConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  layers: z.array(z.enum(['L1', 'L2', 'L3', 'L4'])).default(['L1', 'L2', 'L3', 'L4']),
  agents_config: z.string(),
  timeframes: z.array(z.string()).default(['15m', '4h', '1d']),
})

const AtlasConfigSchema = z.object({
  enabled: z.boolean().default(false),
  model_tiers: z.record(z.string(), z.string()).default({ default: 'haiku' }),
  max_concurrency: z.number().int().min(1).default(5),
  departments: z.array(DepartmentConfigSchema).default([]),
  /** External Obsidian vault path for knowledge mirror. */
  obsidian_vault_path: z.string().optional(),
})

// ==================== Defaults ====================

const DEFAULT_ATLAS_CONFIG: AtlasConfig = {
  enabled: false,
  model_tiers: { default: 'haiku' },
  max_concurrency: 5,
  departments: [],
  obsidian_vault_path: undefined,
}

// ==================== Loaders ====================

/** Read and parse a JSON file, returning undefined on missing file. */
async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

/** Load main atlas.json config. */
export async function loadAtlasConfig(): Promise<AtlasConfig> {
  const raw = await readJsonFile<unknown>(ATLAS_CONFIG_PATH)
  if (!raw) return DEFAULT_ATLAS_CONFIG
  return AtlasConfigSchema.parse(raw)
}

/** Update atlas.json config (partial merge). */
export async function saveAtlasConfig(patch: Partial<AtlasConfig>): Promise<AtlasConfig> {
  const current = await loadAtlasConfig()
  const merged = { ...current, ...patch }
  const validated = AtlasConfigSchema.parse(merged)
  await mkdir(resolve(ATLAS_CONFIG_PATH, '..'), { recursive: true })
  await writeFile(ATLAS_CONFIG_PATH, JSON.stringify(validated, null, 2))
  return validated
}

/** Load agents.json for a specific department. */
export async function loadDepartmentAgents(department: DepartmentConfig): Promise<AgentConfig[]> {
  const agentsPath = resolve(ATLAS_DATA_DIR, department.id, department.agents_config)
  const raw = await readJsonFile<{ agents: unknown[] }>(agentsPath)
  if (!raw?.agents) return []

  const agents: AgentConfig[] = []
  for (const entry of raw.agents) {
    try {
      agents.push(AgentConfigSchema.parse(entry))
    } catch (err) {
      console.warn(`atlas: invalid agent config in ${department.id}:`, err)
    }
  }
  return agents.filter((a) => a.enabled)
}

/** Load prompt file content for an agent.
 * @param baseOrDeptId — department ID (resolved under ATLAS_DATA_DIR) or absolute path when isAbsolute=true
 * @param promptFile — relative path to prompt file within the base dir
 * @param isAbsolute — if true, baseOrDeptId is treated as an absolute directory path
 */
export async function loadPrompt(baseOrDeptId: string, promptFile: string, isAbsolute?: boolean): Promise<string> {
  const promptPath = isAbsolute
    ? resolve(baseOrDeptId, promptFile)
    : resolve(ATLAS_DATA_DIR, baseOrDeptId, promptFile)
  try {
    return await readFile(promptPath, 'utf-8')
  } catch {
    console.warn(`atlas: prompt not found: ${promptPath}`)
    return ''
  }
}

/** Get all enabled departments. */
export async function getEnabledDepartments(): Promise<DepartmentConfig[]> {
  const config = await loadAtlasConfig()
  if (!config.enabled) return []
  return config.departments.filter((d) => d.enabled)
}

/** Resolve model name from tier. */
export function resolveModel(config: AtlasConfig, tier: string): string {
  return config.model_tiers[tier] ?? config.model_tiers['default'] ?? 'haiku'
}

/** Get department data directory path. */
export function getDepartmentDataDir(departmentId: string): string {
  return resolve(ATLAS_DATA_DIR, departmentId)
}

/** Get department knowledge vault path. */
export function getKnowledgeVaultPath(departmentId: string): string {
  return resolve(ATLAS_DATA_DIR, departmentId, 'knowledge')
}

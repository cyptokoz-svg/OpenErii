/**
 * Atlas Config — Load and validate atlas configuration files
 *
 * Loads departments.json, per-department agents.json, and atlas.json.
 * All validated with Zod schemas. Missing files fall back to defaults.
 */

import { readFile, writeFile, mkdir, rm } from 'fs/promises'
import { resolve, basename } from 'path'
import { z } from 'zod'
import type { AtlasConfig, DepartmentConfig, AgentConfig } from './types.js'

// ==================== Paths ====================

const ATLAS_CONFIG_PATH = resolve('data/config/atlas.json')
const ATLAS_DATA_DIR = resolve('data/atlas')

/** Valid department ID: lowercase alphanumeric + underscore/hyphen */
const DEPT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/

/** Valid prompt filename: alphanumeric + underscore/hyphen + .md */
const PROMPT_FILE_RE = /^[a-z0-9][a-z0-9_-]*\.md$/

// ==================== Zod Schemas ====================

const DataSourceSchema = z.object({
  provider: z.string().default(''),
  query: z.string().default(''),
  symbols: z.array(z.string()).optional(),
  type: z.enum(['price', 'current_price', 'news', 'macro', 'equity', 'economy', 'crypto', 'commodity', 'currency', 'cot', 'derivatives', 'correlation', 'volatility', 'weather']).default('price'),
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

/** Load agents.json for a specific department.
 * @param includeDisabled — if true, return all agents regardless of enabled flag
 */
export async function loadDepartmentAgents(department: DepartmentConfig, includeDisabled?: boolean): Promise<AgentConfig[]> {
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
  return includeDisabled ? agents : agents.filter((a) => a.enabled)
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

// ==================== Department CRUD ====================

/** Validate department ID format. */
export function isValidDeptId(id: string): boolean {
  return DEPT_ID_RE.test(id)
}

/** Create directory scaffold for a new department. */
export async function scaffoldDepartment(departmentId: string): Promise<void> {
  if (!isValidDeptId(departmentId)) throw new Error(`Invalid department ID: ${departmentId}`)
  const base = resolve(ATLAS_DATA_DIR, departmentId)
  await mkdir(resolve(base, 'prompts'), { recursive: true })
  await mkdir(resolve(base, 'knowledge'), { recursive: true })
  await mkdir(resolve(base, 'state'), { recursive: true })
  // Create empty agents.json if not exists
  const agentsPath = resolve(base, 'agents.json')
  try { await readFile(agentsPath) } catch {
    await writeFile(agentsPath, JSON.stringify({ agents: [] }, null, 2))
  }
}

/** Add a department to atlas.json and scaffold its data directory. */
export async function createDepartment(dept: Omit<DepartmentConfig, 'agents_config'>): Promise<DepartmentConfig> {
  if (!isValidDeptId(dept.id)) throw new Error(`Invalid department ID: ${dept.id}`)
  const config = await loadAtlasConfig()
  if (config.departments.some((d) => d.id === dept.id)) {
    throw new Error(`Department "${dept.id}" already exists`)
  }
  const full: DepartmentConfig = DepartmentConfigSchema.parse({
    ...dept,
    agents_config: 'agents.json',
  })
  config.departments.push(full)
  await saveAtlasConfig({ departments: config.departments })
  await scaffoldDepartment(dept.id)
  return full
}

/** Update a department in atlas.json. */
export async function updateDepartment(
  departmentId: string,
  patch: Partial<Pick<DepartmentConfig, 'name' | 'enabled' | 'layers' | 'timeframes'>>,
): Promise<DepartmentConfig> {
  const config = await loadAtlasConfig()
  const idx = config.departments.findIndex((d) => d.id === departmentId)
  if (idx < 0) throw new Error(`Department "${departmentId}" not found`)
  const updated = DepartmentConfigSchema.parse({ ...config.departments[idx], ...patch })
  config.departments[idx] = updated
  await saveAtlasConfig({ departments: config.departments })
  return updated
}

/** Remove a department from atlas.json and optionally delete its data directory. */
export async function deleteDepartment(departmentId: string, deleteData = false): Promise<void> {
  if (!isValidDeptId(departmentId)) throw new Error(`Invalid department ID: ${departmentId}`)
  const config = await loadAtlasConfig()
  config.departments = config.departments.filter((d) => d.id !== departmentId)
  await saveAtlasConfig({ departments: config.departments })
  if (deleteData) {
    const dataDir = resolve(ATLAS_DATA_DIR, departmentId)
    await rm(dataDir, { recursive: true, force: true })
  }
}

// ==================== Agent CRUD ====================

/** Load all agents (including disabled) as raw array from agents.json. */
async function loadAllAgentsRaw(departmentId: string): Promise<AgentConfig[]> {
  const agentsPath = resolve(ATLAS_DATA_DIR, departmentId, 'agents.json')
  const raw = await readJsonFile<{ agents: unknown[] }>(agentsPath)
  if (!raw?.agents) return []
  const agents: AgentConfig[] = []
  for (const entry of raw.agents) {
    try { agents.push(AgentConfigSchema.parse(entry)) } catch { /* skip invalid */ }
  }
  return agents
}

/** Save agents array to agents.json. */
export async function saveDepartmentAgents(departmentId: string, agents: AgentConfig[]): Promise<void> {
  if (!isValidDeptId(departmentId)) throw new Error(`Invalid department ID: ${departmentId}`)
  const agentsPath = resolve(ATLAS_DATA_DIR, departmentId, 'agents.json')
  await mkdir(resolve(ATLAS_DATA_DIR, departmentId), { recursive: true })
  await writeFile(agentsPath, JSON.stringify({ agents }, null, 2))
}

/** Add an agent to a department. */
export async function createAgent(departmentId: string, agent: AgentConfig): Promise<AgentConfig> {
  const validated = AgentConfigSchema.parse(agent)
  const agents = await loadAllAgentsRaw(departmentId)
  if (agents.some((a) => a.name === validated.name)) {
    throw new Error(`Agent "${validated.name}" already exists in ${departmentId}`)
  }
  agents.push(validated)
  await saveDepartmentAgents(departmentId, agents)
  return validated
}

/** Update an agent in a department. */
export async function updateAgent(departmentId: string, agentName: string, patch: Partial<AgentConfig>): Promise<AgentConfig> {
  const agents = await loadAllAgentsRaw(departmentId)
  const idx = agents.findIndex((a) => a.name === agentName)
  if (idx < 0) throw new Error(`Agent "${agentName}" not found in ${departmentId}`)
  const updated = AgentConfigSchema.parse({ ...agents[idx], ...patch, name: agentName })
  agents[idx] = updated
  await saveDepartmentAgents(departmentId, agents)
  return updated
}

/** Delete an agent from a department. */
export async function deleteAgent(departmentId: string, agentName: string): Promise<void> {
  const agents = await loadAllAgentsRaw(departmentId)
  const filtered = agents.filter((a) => a.name !== agentName)
  if (filtered.length === agents.length) throw new Error(`Agent "${agentName}" not found`)
  await saveDepartmentAgents(departmentId, filtered)
}

// ==================== Prompt CRUD ====================

/** Save prompt content to a file (with path traversal protection). */
export async function savePrompt(departmentId: string, promptFile: string, content: string): Promise<void> {
  const safe = basename(promptFile)
  if (!PROMPT_FILE_RE.test(safe)) throw new Error(`Invalid prompt filename: ${promptFile}`)
  const promptDir = resolve(ATLAS_DATA_DIR, departmentId, 'prompts')
  await mkdir(promptDir, { recursive: true })
  await writeFile(resolve(promptDir, safe), content, 'utf-8')
}

/** Delete a prompt file. */
export async function deletePrompt(departmentId: string, promptFile: string): Promise<void> {
  const safe = basename(promptFile)
  if (!PROMPT_FILE_RE.test(safe)) throw new Error(`Invalid prompt filename: ${promptFile}`)
  await rm(resolve(ATLAS_DATA_DIR, departmentId, 'prompts', safe), { force: true })
}

/**
 * Backtest State Persistence — Checkpoint and resume
 *
 * Saves backtest progress to disk so long-running simulations
 * can be paused and resumed without losing progress.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import type { BacktestState, BacktestResult, DayResult } from './types.js'

// ==================== Paths ====================

function backtestDir(departmentId: string): string {
  return resolve('data/atlas', departmentId, 'backtest/runs')
}

function stateFile(departmentId: string, runId: string): string {
  return resolve(backtestDir(departmentId), runId, 'state.json')
}

function daysFile(departmentId: string, runId: string): string {
  return resolve(backtestDir(departmentId), runId, 'days.jsonl')
}

function resultFile(departmentId: string, runId: string): string {
  return resolve(backtestDir(departmentId), runId, 'result.json')
}

// ==================== Save / Load State ====================

export async function saveState(departmentId: string, state: BacktestState): Promise<void> {
  const file = stateFile(departmentId, state.id)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(state, null, 2))
}

export async function loadState(departmentId: string, runId: string): Promise<BacktestState | null> {
  try {
    const raw = await readFile(stateFile(departmentId, runId), 'utf-8')
    return JSON.parse(raw) as BacktestState
  } catch {
    return null
  }
}

// ==================== Append Day Result ====================

export async function appendDayResult(departmentId: string, runId: string, day: DayResult): Promise<void> {
  const file = daysFile(departmentId, runId)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(day) + '\n', { flag: 'a' })
}

export async function loadDayResults(departmentId: string, runId: string): Promise<DayResult[]> {
  try {
    const raw = await readFile(daysFile(departmentId, runId), 'utf-8')
    return raw.trim().split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as DayResult)
  } catch {
    return []
  }
}

// ==================== Save / Load Result ====================

export async function saveResult(departmentId: string, result: BacktestResult): Promise<void> {
  const file = resultFile(departmentId, result.id)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(result, null, 2))
}

export async function loadResult(departmentId: string, runId: string): Promise<BacktestResult | null> {
  try {
    const raw = await readFile(resultFile(departmentId, runId), 'utf-8')
    return JSON.parse(raw) as BacktestResult
  } catch {
    return null
  }
}

// ==================== List Runs ====================

export interface RunSummary {
  id: string
  department: string
  status: string
  startDate: string
  endDate: string
  progress: number
  started_at: string
}

export async function listRuns(departmentId: string): Promise<RunSummary[]> {
  const dir = backtestDir(departmentId)
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const runs: RunSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const state = await loadState(departmentId, entry.name)
      if (state) {
        runs.push({
          id: state.id,
          department: state.config.department,
          status: state.status,
          startDate: state.config.startDate,
          endDate: state.config.endDate,
          progress: state.progress,
          started_at: state.started_at,
        })
      }
    }
    return runs.sort((a, b) => b.started_at.localeCompare(a.started_at))
  } catch {
    return []
  }
}

// ==================== Generate Run ID ====================

export function generateRunId(): string {
  const now = new Date()
  const ts = now.toISOString().slice(0, 19).replace(/[:-]/g, '').replace('T', '-')
  const rand = Math.random().toString(36).slice(2, 6)
  return `bt-${ts}-${rand}`
}

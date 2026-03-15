import { describe, it, expect } from 'vitest'
import {
  stripImageData,
  resolveToolPermissions,
  buildChatHistoryPrompt,
  NORMAL_ALLOWED_TOOLS,
  EVOLUTION_ALLOWED_TOOLS,
  NORMAL_EXTRA_DISALLOWED,
  EVOLUTION_EXTRA_DISALLOWED,
  DEFAULT_MAX_HISTORY,
} from './utils.js'

// ==================== stripImageData ====================

describe('stripImageData', () => {
  it('should return non-JSON strings as-is', () => {
    expect(stripImageData('hello world')).toBe('hello world')
  })

  it('should return non-array JSON as-is', () => {
    const obj = JSON.stringify({ type: 'text', text: 'hi' })
    expect(stripImageData(obj)).toBe(obj)
  })

  it('should return array with no image blocks as-is', () => {
    const arr = JSON.stringify([{ type: 'text', text: 'hi' }])
    expect(stripImageData(arr)).toBe(arr)
  })

  it('should strip image blocks with source.data', () => {
    const input = JSON.stringify([
      { type: 'text', text: 'before' },
      { type: 'image', source: { data: 'base64...' } },
      { type: 'text', text: 'after' },
    ])
    const result = JSON.parse(stripImageData(input))
    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ type: 'text', text: 'before' })
    expect(result[1]).toEqual({ type: 'text', text: '[Image saved to disk — use Read tool to view the file]' })
    expect(result[2]).toEqual({ type: 'text', text: 'after' })
  })

  it('should not strip image blocks without source.data', () => {
    const input = JSON.stringify([
      { type: 'image', source: { url: 'https://example.com/img.png' } },
    ])
    expect(stripImageData(input)).toBe(input)
  })

  it('should handle multiple image blocks', () => {
    const input = JSON.stringify([
      { type: 'image', source: { data: 'aaa' } },
      { type: 'image', source: { data: 'bbb' } },
    ])
    const result = JSON.parse(stripImageData(input))
    expect(result).toHaveLength(2)
    expect(result.every((b: { type: string }) => b.type === 'text')).toBe(true)
  })
})

// ==================== resolveToolPermissions ====================

describe('resolveToolPermissions', () => {
  it('should return normal defaults when no options', () => {
    const { allowed, disallowed } = resolveToolPermissions({})
    expect(allowed).toEqual(NORMAL_ALLOWED_TOOLS)
    expect(disallowed).toEqual(NORMAL_EXTRA_DISALLOWED)
  })

  it('should return evolution defaults when evolutionMode is true', () => {
    const { allowed, disallowed } = resolveToolPermissions({ evolutionMode: true })
    expect(allowed).toEqual(EVOLUTION_ALLOWED_TOOLS)
    expect(disallowed).toEqual(EVOLUTION_EXTRA_DISALLOWED)
  })

  it('should use explicit allowedTools when provided', () => {
    const custom = ['MyTool', 'AnotherTool']
    const { allowed } = resolveToolPermissions({ allowedTools: custom })
    expect(allowed).toEqual(custom)
  })

  it('should not use explicit allowedTools when array is empty', () => {
    const { allowed } = resolveToolPermissions({ allowedTools: [] })
    expect(allowed).toEqual(NORMAL_ALLOWED_TOOLS)
  })

  it('should merge disallowedTools with mode defaults', () => {
    const { disallowed } = resolveToolPermissions({ disallowedTools: ['Dangerous'] })
    expect(disallowed).toContain('Dangerous')
    expect(disallowed).toContain('Bash')
  })

  it('should merge disallowedTools with evolution defaults (empty)', () => {
    const { disallowed } = resolveToolPermissions({ evolutionMode: true, disallowedTools: ['Dangerous'] })
    expect(disallowed).toEqual(['Dangerous'])
  })
})

// ==================== buildChatHistoryPrompt ====================

describe('buildChatHistoryPrompt', () => {
  it('should return prompt as-is when history is empty', () => {
    expect(buildChatHistoryPrompt('hello', [])).toBe('hello')
  })

  it('should wrap history in chat_history tags', () => {
    const result = buildChatHistoryPrompt('hello', [
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hey' },
    ])
    expect(result).toContain('<chat_history>')
    expect(result).toContain('</chat_history>')
    expect(result).toContain('[User] hi')
    expect(result).toContain('[Bot] hey')
    expect(result).toMatch(/hello$/)
  })

  it('should use custom preamble', () => {
    const result = buildChatHistoryPrompt('q', [{ role: 'user', text: 'x' }], 'CUSTOM PREAMBLE')
    expect(result).toContain('CUSTOM PREAMBLE')
    expect(result).not.toContain('recent conversation history')
  })

  it('should use default preamble when none provided', () => {
    const result = buildChatHistoryPrompt('q', [{ role: 'user', text: 'x' }])
    expect(result).toContain('recent conversation history')
  })
})

// ==================== Constants ====================

describe('constants', () => {
  it('should have Bash in evolution allowed tools but not normal', () => {
    expect(EVOLUTION_ALLOWED_TOOLS).toContain('Bash')
    expect(NORMAL_ALLOWED_TOOLS).not.toContain('Bash')
  })

  it('should have Bash in normal disallowed', () => {
    expect(NORMAL_EXTRA_DISALLOWED).toContain('Bash')
  })

  it('should have empty evolution disallowed', () => {
    expect(EVOLUTION_EXTRA_DISALLOWED).toHaveLength(0)
  })

  it('should have a positive DEFAULT_MAX_HISTORY', () => {
    expect(DEFAULT_MAX_HISTORY).toBeGreaterThan(0)
  })
})

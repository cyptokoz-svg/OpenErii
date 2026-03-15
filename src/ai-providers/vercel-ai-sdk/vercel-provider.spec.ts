import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VercelAIProvider } from './vercel-provider.js'

vi.mock('./model-factory.js', () => ({
  createModelFromConfig: vi.fn(),
}))

vi.mock('./agent.js', () => ({
  createAgent: vi.fn(),
}))

vi.mock('../../core/media.js', () => ({
  extractMediaFromToolOutput: vi.fn().mockReturnValue([]),
}))

import { createModelFromConfig } from './model-factory.js'
import { createAgent } from './agent.js'

const mockCreateModelFromConfig = vi.mocked(createModelFromConfig)
const mockCreateAgent = vi.mocked(createAgent)

// ==================== Helpers ====================

function makeAgent(text = 'ok', steps: any[] = []) {
  return {
    generate: vi.fn().mockResolvedValue({ text, steps }),
  }
}

function makeProvider(overrides?: { getTools?: () => Promise<Record<string, any>> }) {
  const getTools = overrides?.getTools ?? (async () => ({ toolA: {}, toolB: {} }))
  return new VercelAIProvider(getTools as any, 'You are a trading assistant.', 10)
}

// ==================== resolveAgent caching ====================

describe('VercelAIProvider — agent caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateModelFromConfig.mockResolvedValue({ model: {} as any, key: 'gpt-4o' })
    mockCreateAgent.mockReturnValue(makeAgent() as any)
  })

  it('creates agent on first ask()', async () => {
    const provider = makeProvider()
    await provider.ask('hello')
    expect(mockCreateAgent).toHaveBeenCalledOnce()
  })

  it('reuses cached agent on second ask() when nothing changes', async () => {
    const provider = makeProvider()
    await provider.ask('first')
    await provider.ask('second')
    expect(mockCreateAgent).toHaveBeenCalledOnce()
  })

  it('recreates agent when config key changes', async () => {
    const provider = makeProvider()
    await provider.ask('first')
    // Simulate config key change
    mockCreateModelFromConfig.mockResolvedValue({ model: {} as any, key: 'claude-3-5-sonnet' })
    await provider.ask('second')
    expect(mockCreateAgent).toHaveBeenCalledTimes(2)
  })

  it('recreates agent when tool count changes', async () => {
    let toolSet: Record<string, any> = { toolA: {}, toolB: {} }
    const provider = new VercelAIProvider(async () => toolSet as any, 'prompt', 5)
    await provider.ask('first')
    toolSet = { toolA: {}, toolB: {}, toolC: {} }
    await provider.ask('second')
    expect(mockCreateAgent).toHaveBeenCalledTimes(2)
  })
})

// ==================== per-request overrides ====================

describe('VercelAIProvider — per-request overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateModelFromConfig.mockResolvedValue({ model: {} as any, key: 'gpt-4o' })
    mockCreateAgent.mockReturnValue(makeAgent() as any)
  })

  it('skips cache and uses filtered tools when disabledTools provided', async () => {
    const getTools = async () => ({ toolA: {} as any, toolB: {} as any, toolC: {} as any })
    const provider = new VercelAIProvider(getTools, 'prompt', 5)
    // warm cache
    await provider.ask('warm')
    vi.clearAllMocks()
    mockCreateModelFromConfig.mockResolvedValue({ model: {} as any, key: 'gpt-4o' })
    mockCreateAgent.mockReturnValue(makeAgent() as any)

    // generate with disabledTools
    const events = []
    for await (const e of provider.generate([], 'test', { disabledTools: ['toolB'] })) {
      events.push(e)
    }

    expect(mockCreateAgent).toHaveBeenCalledOnce()
    // The tools passed to createAgent should exclude toolB
    const toolsArg = mockCreateAgent.mock.calls[0][1]
    expect(Object.keys(toolsArg)).toContain('toolA')
    expect(Object.keys(toolsArg)).not.toContain('toolB')
    expect(Object.keys(toolsArg)).toContain('toolC')
  })

  it('skips cache when modelOverride is provided', async () => {
    const provider = makeProvider()
    await provider.ask('warm')
    vi.clearAllMocks()
    mockCreateModelFromConfig.mockResolvedValue({ model: {} as any, key: 'gpt-4o' })
    mockCreateAgent.mockReturnValue(makeAgent() as any)

    for await (const _ of provider.generate([], 'test', { vercelAiSdk: { modelId: 'claude-3-7' } as any })) {
      // drain
    }

    expect(mockCreateAgent).toHaveBeenCalledOnce()
  })
})

// ==================== generate() behavior ====================

describe('VercelAIProvider — generate()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateModelFromConfig.mockResolvedValue({ model: {} as any, key: 'gpt-4o' })
    mockCreateAgent.mockReturnValue(makeAgent() as any)
  })

  it('yields done event with text from result', async () => {
    const provider = makeProvider()
    const agent = makeAgent('final answer')
    mockCreateAgent.mockReturnValue(agent as any)

    const events = []
    for await (const e of provider.generate([], 'test')) {
      events.push(e)
    }

    const done = events.find((e) => e.type === 'done')
    expect(done?.result.text).toBe('final answer')
  })

  it('propagates agent error through channel', async () => {
    const agent = { generate: vi.fn().mockRejectedValue(new Error('model error')) }
    mockCreateAgent.mockReturnValue(agent as any)
    const provider = makeProvider()

    await expect(async () => {
      for await (const _ of provider.generate([], 'test')) {
        // drain
      }
    }).rejects.toThrow('model error')
  })
})

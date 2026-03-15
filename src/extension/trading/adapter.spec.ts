import { describe, it, expect, beforeEach } from 'vitest'
import { resolveAccounts, resolveOne, createTradingTools } from './adapter.js'
import { AccountManager } from './account-manager.js'
import { MockTradingAccount, makePosition, makeContract } from './__test__/mock-account.js'

// ==================== Helpers ====================

function makeManager(...accounts: MockTradingAccount[]): AccountManager {
  const mgr = new AccountManager()
  for (const acc of accounts) mgr.addAccount(acc)
  return mgr
}

function makeResolver(mgr: AccountManager) {
  return {
    accountManager: mgr,
    getGit: () => undefined,
    getGitState: () => undefined,
  }
}

// ==================== resolveAccounts ====================

describe('resolveAccounts', () => {
  let alpaca: MockTradingAccount
  let ccxt: MockTradingAccount
  let mgr: AccountManager

  beforeEach(() => {
    alpaca = new MockTradingAccount({ id: 'alpaca-paper', provider: 'alpaca', label: 'Alpaca Paper' })
    ccxt = new MockTradingAccount({ id: 'bybit-main', provider: 'ccxt', label: 'Bybit Main' })
    mgr = makeManager(alpaca, ccxt)
  })

  it('returns all accounts when source is not provided', () => {
    const results = resolveAccounts(mgr)
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id).sort()).toEqual(['alpaca-paper', 'bybit-main'])
  })

  it('returns single account by exact id', () => {
    const results = resolveAccounts(mgr, 'alpaca-paper')
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('alpaca-paper')
    expect(results[0].account).toBe(alpaca)
  })

  it('returns all accounts matching a provider name', () => {
    const ccxt2 = new MockTradingAccount({ id: 'binance-main', provider: 'ccxt', label: 'Binance' })
    mgr.addAccount(ccxt2)
    const results = resolveAccounts(mgr, 'ccxt')
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.id).sort()).toEqual(['binance-main', 'bybit-main'])
  })

  it('returns empty array when source matches nothing', () => {
    const results = resolveAccounts(mgr, 'nonexistent')
    expect(results).toHaveLength(0)
  })

  it('prefers id match over provider match when source matches both', () => {
    // Account id equals another account's provider name (edge case)
    const special = new MockTradingAccount({ id: 'alpaca', provider: 'mock', label: 'Special' })
    mgr.addAccount(special)
    const results = resolveAccounts(mgr, 'alpaca')
    // id match returns immediately
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('alpaca')
  })
})

// ==================== resolveOne ====================

describe('resolveOne', () => {
  let mgr: AccountManager

  beforeEach(() => {
    mgr = makeManager(
      new MockTradingAccount({ id: 'alpaca-paper', provider: 'alpaca' }),
      new MockTradingAccount({ id: 'bybit-main', provider: 'ccxt' }),
    )
  })

  it('returns the single matching account', () => {
    const result = resolveOne(mgr, 'alpaca-paper')
    expect(result.id).toBe('alpaca-paper')
  })

  it('throws when no account matches', () => {
    expect(() => resolveOne(mgr, 'unknown-id')).toThrow('No account found matching source "unknown-id"')
  })

  it('throws with disambiguation info when multiple accounts match provider', () => {
    mgr.addAccount(new MockTradingAccount({ id: 'alpaca-live', provider: 'alpaca' }))
    expect(() => resolveOne(mgr, 'alpaca')).toThrow(/Multiple accounts match source "alpaca"/)
  })
})

// ==================== createTradingTools: listAccounts ====================

describe('createTradingTools — listAccounts', () => {
  it('returns summaries for all registered accounts', async () => {
    const mgr = makeManager(
      new MockTradingAccount({ id: 'acc1', provider: 'alpaca', label: 'Test' }),
    )
    const tools = createTradingTools(makeResolver(mgr))
    const result = await (tools.listAccounts.execute as Function)({})
    expect(Array.isArray(result)).toBe(true)
    expect(result[0].id).toBe('acc1')
    expect(result[0].provider).toBe('alpaca')
  })
})

// ==================== createTradingTools: searchContracts ====================

describe('createTradingTools — searchContracts', () => {
  it('aggregates results from all accounts', async () => {
    const a1 = new MockTradingAccount({ id: 'acc1', provider: 'alpaca' })
    const a2 = new MockTradingAccount({ id: 'acc2', provider: 'ccxt' })
    a1.searchContracts.mockResolvedValue([{ contract: makeContract({ symbol: 'AAPL' }) }])
    a2.searchContracts.mockResolvedValue([{ contract: makeContract({ symbol: 'AAPL' }) }])
    const mgr = makeManager(a1, a2)
    const tools = createTradingTools(makeResolver(mgr))
    const result = await (tools.searchContracts.execute as Function)({ pattern: 'AAPL' })
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
    expect(result[0].source).toBe('acc1')
    expect(result[1].source).toBe('acc2')
  })

  it('returns no-results message when no accounts found anything', async () => {
    const a1 = new MockTradingAccount({ id: 'acc1' })
    a1.searchContracts.mockResolvedValue([])
    const mgr = makeManager(a1)
    const tools = createTradingTools(makeResolver(mgr))
    const result = await (tools.searchContracts.execute as Function)({ pattern: 'ZZZZ' })
    expect(result.results).toEqual([])
    expect(result.message).toContain('No contracts found')
  })

  it('returns error when no accounts are registered', async () => {
    const mgr = new AccountManager()
    const tools = createTradingTools(makeResolver(mgr))
    const result = await (tools.searchContracts.execute as Function)({ pattern: 'AAPL' })
    expect(result.error).toBeTruthy()
  })

  it('skips accounts that throw during searchContracts', async () => {
    const a1 = new MockTradingAccount({ id: 'acc1' })
    const a2 = new MockTradingAccount({ id: 'acc2' })
    a1.searchContracts.mockRejectedValue(new Error('connection error'))
    a2.searchContracts.mockResolvedValue([{ contract: makeContract({ symbol: 'BTC' }) }])
    const mgr = makeManager(a1, a2)
    const tools = createTradingTools(makeResolver(mgr))
    const result = await (tools.searchContracts.execute as Function)({ pattern: 'BTC' })
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe('acc2')
  })
})

// ==================== createTradingTools: getPortfolio ====================

describe('createTradingTools — getPortfolio', () => {
  it('returns all positions when symbol is omitted', async () => {
    const acc = new MockTradingAccount({ id: 'acc1' })
    acc.setPositions([
      makePosition({ contract: makeContract({ symbol: 'AAPL' }) }),
      makePosition({ contract: makeContract({ symbol: 'TSLA' }) }),
    ])
    const mgr = makeManager(acc)
    const tools = createTradingTools(makeResolver(mgr))
    const result = await (tools.getPortfolio.execute as Function)({ source: 'acc1' })
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
  })

  it('filters to specific symbol when provided', async () => {
    const acc = new MockTradingAccount({ id: 'acc1' })
    acc.setPositions([
      makePosition({ contract: makeContract({ symbol: 'AAPL' }) }),
      makePosition({ contract: makeContract({ symbol: 'TSLA' }) }),
    ])
    const mgr = makeManager(acc)
    const tools = createTradingTools(makeResolver(mgr))
    const result = await (tools.getPortfolio.execute as Function)({ source: 'acc1', symbol: 'AAPL' })
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect(result[0].symbol).toBe('AAPL')
  })
})

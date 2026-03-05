import { describe, it, expect, beforeEach } from 'vitest'
import { AccountManager } from './account-manager.js'
import {
  MockTradingAccount,
  makeContract,
} from './__test__/mock-account.js'

describe('AccountManager', () => {
  let manager: AccountManager

  beforeEach(() => {
    manager = new AccountManager()
  })

  // ==================== Registration ====================

  describe('addAccount / removeAccount', () => {
    it('adds and retrieves an account', () => {
      const acct = new MockTradingAccount({ id: 'a1' })
      manager.addAccount(acct)

      expect(manager.getAccount('a1')).toBe(acct)
      expect(manager.has('a1')).toBe(true)
      expect(manager.size).toBe(1)
    })

    it('throws on duplicate id', () => {
      manager.addAccount(new MockTradingAccount({ id: 'a1' }))
      expect(() =>
        manager.addAccount(new MockTradingAccount({ id: 'a1' })),
      ).toThrow('already registered')
    })

    it('removes an account', () => {
      manager.addAccount(new MockTradingAccount({ id: 'a1' }))
      manager.removeAccount('a1')
      expect(manager.has('a1')).toBe(false)
      expect(manager.size).toBe(0)
    })

    it('returns undefined for unknown id', () => {
      expect(manager.getAccount('nope')).toBeUndefined()
    })
  })

  // ==================== listAccounts ====================

  describe('listAccounts', () => {
    it('returns summaries of all accounts', () => {
      manager.addAccount(new MockTradingAccount({ id: 'a1', provider: 'alpaca', label: 'Paper' }))
      manager.addAccount(new MockTradingAccount({ id: 'a2', provider: 'ccxt', label: 'Bybit' }))

      const list = manager.listAccounts()
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe('a1')
      expect(list[0].provider).toBe('alpaca')
      expect(list[1].id).toBe('a2')
    })

    it('includes platformId when provided', () => {
      manager.addAccount(new MockTradingAccount({ id: 'a1', provider: 'alpaca' }), 'alpaca-paper')
      manager.addAccount(new MockTradingAccount({ id: 'a2', provider: 'ccxt' }))

      const list = manager.listAccounts()
      expect(list[0].platformId).toBe('alpaca-paper')
      expect(list[1].platformId).toBeUndefined()
    })
  })

  // ==================== getAggregatedEquity ====================

  describe('getAggregatedEquity', () => {
    it('aggregates equity across accounts', async () => {
      const a1 = new MockTradingAccount({ id: 'a1', label: 'A', accountInfo: { equity: 50_000, cash: 30_000, unrealizedPnL: 2_000, realizedPnL: 500 } })
      const a2 = new MockTradingAccount({ id: 'a2', label: 'B', accountInfo: { equity: 75_000, cash: 60_000, unrealizedPnL: 3_000, realizedPnL: 1_000 } })
      manager.addAccount(a1)
      manager.addAccount(a2)

      const result = await manager.getAggregatedEquity()
      expect(result.totalEquity).toBe(125_000)
      expect(result.totalCash).toBe(90_000)
      expect(result.totalUnrealizedPnL).toBe(5_000)
      expect(result.totalRealizedPnL).toBe(1_500)
      expect(result.accounts).toHaveLength(2)
    })

    it('returns zeros when no accounts', async () => {
      const result = await manager.getAggregatedEquity()
      expect(result.totalEquity).toBe(0)
      expect(result.accounts).toHaveLength(0)
    })
  })

  // ==================== searchContracts ====================

  describe('searchContracts', () => {
    it('searches all accounts by default', async () => {
      const a1 = new MockTradingAccount({ id: 'a1' })
      a1.searchContracts.mockResolvedValue([{ contract: makeContract({ aliceId: 'a1-AAPL' }) }])
      const a2 = new MockTradingAccount({ id: 'a2' })
      a2.searchContracts.mockResolvedValue([{ contract: makeContract({ aliceId: 'a2-AAPL' }) }])

      manager.addAccount(a1)
      manager.addAccount(a2)

      const results = await manager.searchContracts('AAPL')
      expect(results).toHaveLength(2)
    })

    it('scopes search to specific accountId', async () => {
      const a1 = new MockTradingAccount({ id: 'a1' })
      a1.searchContracts.mockResolvedValue([{ contract: makeContract({ aliceId: 'a1-AAPL' }) }])
      const a2 = new MockTradingAccount({ id: 'a2' })
      a2.searchContracts.mockResolvedValue([{ contract: makeContract({ aliceId: 'a2-AAPL' }) }])

      manager.addAccount(a1)
      manager.addAccount(a2)

      const results = await manager.searchContracts('AAPL', 'a1')
      expect(results).toHaveLength(1)
      expect(results[0].accountId).toBe('a1')
    })

    it('excludes accounts with no matches', async () => {
      const a1 = new MockTradingAccount({ id: 'a1' })
      a1.searchContracts.mockResolvedValue([])
      const a2 = new MockTradingAccount({ id: 'a2' })
      a2.searchContracts.mockResolvedValue([{ contract: makeContract() }])

      manager.addAccount(a1)
      manager.addAccount(a2)

      const results = await manager.searchContracts('AAPL')
      expect(results).toHaveLength(1)
      expect(results[0].accountId).toBe('a2')
    })
  })

  // ==================== getContractDetails ====================

  describe('getContractDetails', () => {
    it('returns details from specified account', async () => {
      const a1 = new MockTradingAccount({ id: 'a1' })
      manager.addAccount(a1)

      const details = await manager.getContractDetails({ symbol: 'AAPL' }, 'a1')
      expect(details).not.toBeNull()
      expect(details!.contract.symbol).toBe('AAPL')
      expect(details!.longName).toBe('Apple Inc.')
    })

    it('returns null for unknown account', async () => {
      const details = await manager.getContractDetails({ symbol: 'AAPL' }, 'nope')
      expect(details).toBeNull()
    })
  })

  // ==================== closeAll ====================

  describe('closeAll', () => {
    it('calls close on all accounts and clears entries', async () => {
      const a1 = new MockTradingAccount({ id: 'a1' })
      const a2 = new MockTradingAccount({ id: 'a2' })
      manager.addAccount(a1)
      manager.addAccount(a2)

      await manager.closeAll()

      expect(a1.close).toHaveBeenCalled()
      expect(a2.close).toHaveBeenCalled()
      expect(manager.size).toBe(0)
    })

    it('does not throw if one account fails to close', async () => {
      const a1 = new MockTradingAccount({ id: 'a1' })
      a1.close.mockRejectedValue(new Error('close failed'))
      manager.addAccount(a1)

      // Should not throw
      await manager.closeAll()
      expect(manager.size).toBe(0)
    })
  })
})

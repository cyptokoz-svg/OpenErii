/**
 * AccountManager — multi-account registry and aggregation
 *
 * Holds all ITradingAccount instances, provides cross-account operations
 * like aggregated equity and global contract search.
 */

import type { Contract, ContractDescription, ContractDetails } from './contract.js'
import type { ITradingAccount, AccountCapabilities } from './interfaces.js'

// ==================== Account entry ====================

export interface AccountEntry {
  account: ITradingAccount
  platformId?: string
}

export interface AccountSummary {
  id: string
  provider: string
  label: string
  platformId?: string
  capabilities: AccountCapabilities
}

// ==================== Aggregated equity ====================

export interface AggregatedEquity {
  totalEquity: number
  totalCash: number
  totalUnrealizedPnL: number
  totalRealizedPnL: number
  accounts: Array<{
    id: string
    label: string
    equity: number
    cash: number
    unrealizedPnL: number
  }>
}

// ==================== Contract search result ====================

export interface ContractSearchResult {
  accountId: string
  results: ContractDescription[]
}

// ==================== AccountManager ====================

export class AccountManager {
  private entries = new Map<string, AccountEntry>()

  // ---- Registration ----

  addAccount(account: ITradingAccount, platformId?: string): void {
    if (this.entries.has(account.id)) {
      throw new Error(`Account "${account.id}" already registered`)
    }
    this.entries.set(account.id, { account, platformId })
  }

  removeAccount(id: string): void {
    this.entries.delete(id)
  }

  // ---- Lookups ----

  getAccount(id: string): ITradingAccount | undefined {
    return this.entries.get(id)?.account
  }

  listAccounts(): AccountSummary[] {
    return Array.from(this.entries.values()).map(({ account, platformId }) => ({
      id: account.id,
      provider: account.provider,
      label: account.label,
      platformId,
      capabilities: account.getCapabilities(),
    }))
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  get size(): number {
    return this.entries.size
  }

  // ---- Cross-account aggregation ----

  async getAggregatedEquity(): Promise<AggregatedEquity> {
    const results = await Promise.all(
      Array.from(this.entries.values()).map(async ({ account }) => {
        const info = await account.getAccount()
        return { id: account.id, label: account.label, info }
      }),
    )

    let totalEquity = 0
    let totalCash = 0
    let totalUnrealizedPnL = 0
    let totalRealizedPnL = 0
    const accounts: AggregatedEquity['accounts'] = []

    for (const { id, label, info } of results) {
      totalEquity += info.equity
      totalCash += info.cash
      totalUnrealizedPnL += info.unrealizedPnL
      totalRealizedPnL += info.realizedPnL
      accounts.push({
        id,
        label,
        equity: info.equity,
        cash: info.cash,
        unrealizedPnL: info.unrealizedPnL,
      })
    }

    return { totalEquity, totalCash, totalUnrealizedPnL, totalRealizedPnL, accounts }
  }

  // ---- Cross-account contract search ----

  /**
   * Fuzzy search all accounts for matching contracts (IBKR: reqMatchingSymbols).
   * If accountId is specified, only searches that account.
   */
  async searchContracts(
    pattern: string,
    accountId?: string,
  ): Promise<ContractSearchResult[]> {
    const targets = accountId
      ? [this.entries.get(accountId)].filter(Boolean) as AccountEntry[]
      : Array.from(this.entries.values())

    const results = await Promise.all(
      targets.map(async ({ account }) => {
        const descriptions = await account.searchContracts(pattern)
        return { accountId: account.id, results: descriptions }
      }),
    )

    return results.filter((r) => r.results.length > 0)
  }

  /**
   * Get full contract details from a specific account (IBKR: reqContractDetails).
   */
  async getContractDetails(
    query: Partial<Contract>,
    accountId: string,
  ): Promise<ContractDetails | null> {
    const entry = this.entries.get(accountId)
    if (!entry) return null
    return entry.account.getContractDetails(query)
  }

  // ---- Lifecycle ----

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.entries.values()).map(({ account }) => account.close()),
    )
    this.entries.clear()
  }
}

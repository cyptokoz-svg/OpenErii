/**
 * Platform — structural definition for a broker/exchange configuration.
 *
 * A platform defines HOW to connect (exchange type, market mode, sandbox settings).
 * Multiple accounts can share one platform, each with individual credentials.
 * The platform acts as a typed factory for accounts.
 */

import type { ITradingAccount } from './interfaces.js'

/** Credentials passed to IPlatform.createAccount(). */
export interface PlatformCredentials {
  id: string
  label?: string
  apiKey?: string
  apiSecret?: string
  password?: string
}

export interface IPlatform {
  /** Unique platform id, e.g. "bybit-swap", "alpaca-paper". */
  readonly id: string

  /** Human-readable name, e.g. "Bybit USDT Perps". */
  readonly label: string

  /**
   * Provider class tag. Matches ITradingAccount.provider on created accounts.
   * CcxtPlatform → exchange name (e.g. "bybit").
   * AlpacaPlatform → "alpaca".
   */
  readonly providerType: string

  /** Create a new ITradingAccount instance from per-account credentials. */
  createAccount(credentials: PlatformCredentials): ITradingAccount
}

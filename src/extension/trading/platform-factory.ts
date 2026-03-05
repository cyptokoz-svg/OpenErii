/**
 * Platform Factory — creates IPlatform and ITradingAccount from config.
 */

import type { IPlatform, PlatformCredentials } from './platform.js'
import type { ITradingAccount } from './interfaces.js'
import { CcxtPlatform } from './providers/ccxt/CcxtPlatform.js'
import { AlpacaPlatform } from './providers/alpaca/AlpacaPlatform.js'
import type { PlatformConfig, AccountConfig } from '../../core/config.js'

/** Create an IPlatform from a parsed PlatformConfig. */
export function createPlatformFromConfig(config: PlatformConfig): IPlatform {
  switch (config.type) {
    case 'ccxt':
      return new CcxtPlatform({
        id: config.id,
        label: config.label,
        exchange: config.exchange,
        sandbox: config.sandbox,
        demoTrading: config.demoTrading,
        defaultMarketType: config.defaultMarketType,
        options: config.options,
      })
    case 'alpaca':
      return new AlpacaPlatform({
        id: config.id,
        label: config.label,
        paper: config.paper,
      })
  }
}

/** Create an ITradingAccount from a platform + account config. */
export function createAccountFromConfig(
  platform: IPlatform,
  accountConfig: AccountConfig,
): ITradingAccount {
  const credentials: PlatformCredentials = {
    id: accountConfig.id,
    label: accountConfig.label,
    apiKey: accountConfig.apiKey,
    apiSecret: accountConfig.apiSecret,
    password: accountConfig.password,
  }
  return platform.createAccount(credentials)
}

/** Validate that all account platformId references resolve to a known platform. */
export function validatePlatformRefs(
  platforms: IPlatform[],
  accounts: AccountConfig[],
): void {
  const platformIds = new Set(platforms.map((p) => p.id))
  for (const acc of accounts) {
    if (!platformIds.has(acc.platformId)) {
      throw new Error(
        `Account "${acc.id}" references unknown platformId "${acc.platformId}". ` +
          `Available platforms: ${[...platformIds].join(', ')}`,
      )
    }
  }
}

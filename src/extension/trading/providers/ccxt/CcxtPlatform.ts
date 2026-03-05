import type { IPlatform, PlatformCredentials } from '../../platform.js'
import { CcxtAccount } from './CcxtAccount.js'

export interface CcxtPlatformConfig {
  id: string
  label?: string
  exchange: string
  sandbox: boolean
  demoTrading?: boolean
  defaultMarketType: 'spot' | 'swap'
  options?: Record<string, unknown>
}

export class CcxtPlatform implements IPlatform {
  readonly id: string
  readonly label: string
  readonly providerType: string

  private readonly config: CcxtPlatformConfig

  constructor(config: CcxtPlatformConfig) {
    this.config = config
    this.id = config.id
    this.providerType = config.exchange
    const exchangeLabel = config.exchange.charAt(0).toUpperCase() + config.exchange.slice(1)
    this.label = config.label ?? `${exchangeLabel} ${config.defaultMarketType} (${config.sandbox ? 'testnet' : 'live'})`
  }

  createAccount(credentials: PlatformCredentials): CcxtAccount {
    return new CcxtAccount({
      id: credentials.id,
      label: credentials.label,
      exchange: this.config.exchange,
      apiKey: credentials.apiKey ?? '',
      apiSecret: credentials.apiSecret ?? '',
      password: credentials.password,
      sandbox: this.config.sandbox,
      demoTrading: this.config.demoTrading,
      defaultMarketType: this.config.defaultMarketType,
      options: this.config.options,
    })
  }
}

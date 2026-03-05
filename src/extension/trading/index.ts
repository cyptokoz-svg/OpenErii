// Contract
export type {
  Contract,
  SecType,
  OptionType,
  ComboLeg,
  DeltaNeutralContract,
} from './contract.js'

// Interfaces
export type {
  Position,
  OrderRequest,
  OrderResult,
  Order,
  AccountInfo,
  Quote,
  FundingRate,
  OrderBookLevel,
  OrderBook,
  MarketClock,
  AccountCapabilities,
  ITradingAccount,
  WalletState,
} from './interfaces.js'

// AccountManager
export { AccountManager } from './account-manager.js'
export type {
  AccountEntry,
  AccountSummary,
  AggregatedEquity,
  ContractSearchResult,
} from './account-manager.js'

// Trading-as-Git
export { TradingGit } from './git/index.js'
export type {
  ITradingGit,
  TradingGitConfig,
  CommitHash,
  Operation,
  OperationAction,
  OperationResult,
  OperationStatus,
  AddResult,
  CommitPrepareResult,
  PushResult,
  GitStatus,
  GitCommit,
  GitState,
  CommitLogEntry,
  GitExportState,
  OperationSummary,
  OrderStatusUpdate,
  SyncResult,
  PriceChangeInput,
  SimulatePriceChangeResult,
} from './git/index.js'

// Guards
export {
  createGuardPipeline,
  registerGuard,
  resolveGuards,
  MaxPositionSizeGuard,
  CooldownGuard,
  SymbolWhitelistGuard,
} from './guards/index.js'
export type {
  GuardContext,
  OperationGuard,
  GuardRegistryEntry,
} from './guards/index.js'

// Operation Dispatcher
export { createOperationDispatcher } from './operation-dispatcher.js'

// Wallet State Bridge
export { createWalletStateBridge } from './wallet-state-bridge.js'

// Platform
export type { IPlatform, PlatformCredentials } from './platform.js'
export { CcxtPlatform } from './providers/ccxt/CcxtPlatform.js'
export type { CcxtPlatformConfig } from './providers/ccxt/CcxtPlatform.js'
export { AlpacaPlatform } from './providers/alpaca/AlpacaPlatform.js'
export type { AlpacaPlatformConfig } from './providers/alpaca/AlpacaPlatform.js'
export {
  createPlatformFromConfig,
  createAccountFromConfig,
  validatePlatformRefs,
} from './platform-factory.js'

// Factory (wiring)
export { wireAccountTrading } from './factory.js'
export type { AccountSetup } from './factory.js'

// Unified Tool Factory
export { createTradingTools, resolveAccounts, resolveOne } from './adapter.js'
export type { AccountResolver, ResolvedAccount } from './adapter.js'

// Providers
export { AlpacaAccount } from './providers/alpaca/index.js'
export type { AlpacaAccountConfig } from './providers/alpaca/index.js'
export { CcxtAccount } from './providers/ccxt/index.js'
export type { CcxtAccountConfig } from './providers/ccxt/index.js'

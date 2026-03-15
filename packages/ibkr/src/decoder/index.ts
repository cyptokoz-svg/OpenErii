/**
 * Decoder module — assembles base + all handler groups.
 *
 * Usage:
 *   import { Decoder, applyAllHandlers } from './decoder'
 *   const decoder = new Decoder(wrapper, serverVersion)
 *   applyAllHandlers(decoder)
 */

import { Decoder } from './base'
import { applyMarketDataHandlers } from './market-data'
import { applyOrderHandlers } from './orders'
import { applyAccountHandlers } from './account'
import { applyContractHandlers } from './contract'
import { applyExecutionHandlers } from './execution'
import { applyHistoricalHandlers } from './historical'
import { applyMiscHandlers } from './misc'

export function applyAllHandlers(decoder: Decoder): void {
  applyMarketDataHandlers(decoder)
  applyOrderHandlers(decoder)
  applyAccountHandlers(decoder)
  applyContractHandlers(decoder)
  applyExecutionHandlers(decoder)
  applyHistoricalHandlers(decoder)
  applyMiscHandlers(decoder)
}

export { Decoder }

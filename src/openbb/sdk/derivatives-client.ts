/**
 * SDK Derivatives Client
 *
 * Futures and options data via OpenTypeBB in-process executor.
 */

import { SDKBaseClient } from './base-client.js'

export class SDKDerivativesClient extends SDKBaseClient {
  // ==================== Futures ====================

  async getFuturesCurve(params: Record<string, unknown>) {
    return this.request('/futures/curve', params)
  }

  async getFuturesHistorical(params: Record<string, unknown>) {
    return this.request('/futures/historical', params)
  }

  async getFuturesInfo(params: Record<string, unknown>) {
    return this.request('/futures/info', params)
  }
}

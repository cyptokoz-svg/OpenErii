import { describe, it, expect, vi, beforeEach } from 'vitest'
import { computeRealizedPnL } from './alpaca-pnl.js'
import { AlpacaAccount } from './AlpacaAccount.js'

// ==================== Alpaca SDK mock ====================

vi.mock('@alpacahq/alpaca-trade-api', () => {
  const MockAlpaca = vi.fn(function (this: any) {
    this.getAccount = vi.fn()
    this.getPositions = vi.fn()
    this.createOrder = vi.fn()
    this.replaceOrder = vi.fn()
    this.cancelOrder = vi.fn()
    this.closePosition = vi.fn()
    this.getOrders = vi.fn()
    this.getSnapshot = vi.fn()
    this.getClock = vi.fn()
    this.getAccountActivities = vi.fn()
  })
  return { default: MockAlpaca }
})

/** Helper to build a fill activity record. */
function fill(symbol: string, side: 'buy' | 'sell', qty: number, price: number, index = 0) {
  return {
    activity_type: 'FILL' as const,
    symbol,
    side,
    qty: String(qty),
    price: String(price),
    cum_qty: String(qty),
    leaves_qty: '0',
    transaction_time: `2025-01-01T00:00:0${index}Z`,
    order_id: `order-${index}`,
    type: 'fill',
  }
}

describe('computeRealizedPnL', () => {
  it('returns 0 for empty fills', () => {
    expect(computeRealizedPnL([])).toBe(0)
  })

  it('returns 0 when only buys (no closes)', () => {
    const fills = [
      fill('AAPL', 'buy', 10, 150, 0),
      fill('GOOG', 'buy', 5, 2800, 1),
    ]
    expect(computeRealizedPnL(fills)).toBe(0)
  })

  it('computes profit on simple buy then sell', () => {
    const fills = [
      fill('AAPL', 'buy', 10, 150, 0),
      fill('AAPL', 'sell', 10, 160, 1),
    ]
    // (160 - 150) * 10 = 100
    expect(computeRealizedPnL(fills)).toBe(100)
  })

  it('computes loss on simple buy then sell', () => {
    const fills = [
      fill('AAPL', 'buy', 10, 150, 0),
      fill('AAPL', 'sell', 10, 140, 1),
    ]
    // (140 - 150) * 10 = -100
    expect(computeRealizedPnL(fills)).toBe(-100)
  })

  it('handles partial close (sell less than bought)', () => {
    const fills = [
      fill('AAPL', 'buy', 10, 150, 0),
      fill('AAPL', 'sell', 4, 160, 1),
    ]
    // (160 - 150) * 4 = 40
    expect(computeRealizedPnL(fills)).toBe(40)
  })

  it('handles FIFO across multiple buy lots', () => {
    const fills = [
      fill('AAPL', 'buy', 5, 100, 0),
      fill('AAPL', 'buy', 5, 120, 1),
      fill('AAPL', 'sell', 7, 130, 2),
    ]
    // FIFO: first lot 5@100 → (130-100)*5 = 150
    //        second lot 2@120 → (130-120)*2 = 20
    // total = 170
    expect(computeRealizedPnL(fills)).toBe(170)
  })

  it('handles multiple symbols independently', () => {
    const fills = [
      fill('AAPL', 'buy', 10, 150, 0),
      fill('GOOG', 'buy', 2, 2800, 1),
      fill('AAPL', 'sell', 10, 160, 2),
      fill('GOOG', 'sell', 2, 2700, 3),
    ]
    // AAPL: (160-150)*10 = 100
    // GOOG: (2700-2800)*2 = -200
    // total = -100
    expect(computeRealizedPnL(fills)).toBe(-100)
  })

  it('handles short selling (sell then buy)', () => {
    const fills = [
      fill('AAPL', 'sell', 10, 160, 0),
      fill('AAPL', 'buy', 10, 150, 1),
    ]
    // Short: entry 160, exit 150 → (160-150)*10 = 100 profit
    expect(computeRealizedPnL(fills)).toBe(100)
  })

  it('handles short selling at a loss', () => {
    const fills = [
      fill('AAPL', 'sell', 10, 150, 0),
      fill('AAPL', 'buy', 10, 160, 1),
    ]
    // Short: entry 150, exit 160 → (150-160)*10 = -100 loss
    expect(computeRealizedPnL(fills)).toBe(-100)
  })

  it('handles multiple round trips', () => {
    const fills = [
      fill('AAPL', 'buy', 10, 100, 0),
      fill('AAPL', 'sell', 10, 110, 1),
      fill('AAPL', 'buy', 10, 105, 2),
      fill('AAPL', 'sell', 10, 115, 3),
    ]
    // Trip 1: (110-100)*10 = 100
    // Trip 2: (115-105)*10 = 100
    // total = 200
    expect(computeRealizedPnL(fills)).toBe(200)
  })

  it('rounds to cents', () => {
    const fills = [
      fill('AAPL', 'buy', 3, 10.333, 0),
      fill('AAPL', 'sell', 3, 10.667, 1),
    ]
    // (10.667 - 10.333) * 3 = 1.002
    expect(computeRealizedPnL(fills)).toBe(1)
  })
})

// ==================== AlpacaAccount ====================

function makeClient(account: any) {
  // After construction, Alpaca SDK is mocked — get the instance via the constructor mock
  const Alpaca = require('@alpacahq/alpaca-trade-api').default
  const instance = new Alpaca.mock.instances[Alpaca.mock.instances.length - 1]
  // Actually, we get the client by inspecting mock calls more carefully below.
  return account
}

function getLastAlpacaInstance() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Alpaca = require('@alpacahq/alpaca-trade-api').default
  return Alpaca.mock.instances[Alpaca.mock.instances.length - 1]
}

describe('AlpacaAccount — init()', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws when no apiKey is configured', async () => {
    const acc = new AlpacaAccount({ apiKey: '', secretKey: '' })
    await expect(acc.init()).rejects.toThrow('No API credentials')
  })

  it('throws when no secretKey is configured', async () => {
    const acc = new AlpacaAccount({ apiKey: 'key', secretKey: '' })
    await expect(acc.init()).rejects.toThrow('No API credentials')
  })

  it('resolves on successful getAccount()', async () => {
    const acc = new AlpacaAccount({ apiKey: 'key', secretKey: 'secret', paper: true })
    // Alpaca constructor is mocked — set up getAccount on the instance
    // We need to patch BEFORE init() is called but AFTER AlpacaAccount constructor runs
    // The AlpacaAccount constructor does NOT call new Alpaca yet — init() does.
    // So we set up the mock inside the test before calling init().
    const { default: Alpaca } = await import('@alpacahq/alpaca-trade-api')
    ;(Alpaca as any).mockImplementationOnce(function (this: any) {
      this.getAccount = vi.fn().mockResolvedValue({ equity: '50000', paper: true })
      this.getPositions = vi.fn()
      this.createOrder = vi.fn()
      this.replaceOrder = vi.fn()
      this.cancelOrder = vi.fn()
      this.closePosition = vi.fn()
      this.getOrders = vi.fn()
      this.getSnapshot = vi.fn()
      this.getClock = vi.fn()
      this.getAccountActivities = vi.fn()
    })
    await expect(acc.init()).resolves.toBeUndefined()
  })

  it('throws authentication error after MAX_AUTH_RETRIES on 401', async () => {
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any) => { fn(); return 0 as any })
    const acc = new AlpacaAccount({ apiKey: 'bad', secretKey: 'bad', paper: true })
    const { default: Alpaca } = await import('@alpacahq/alpaca-trade-api')
    ;(Alpaca as any).mockImplementationOnce(function (this: any) {
      this.getAccount = vi.fn().mockRejectedValue(new Error('401 Unauthorized'))
      this.getPositions = vi.fn()
      this.createOrder = vi.fn()
      this.replaceOrder = vi.fn()
      this.cancelOrder = vi.fn()
      this.closePosition = vi.fn()
      this.getOrders = vi.fn()
      this.getSnapshot = vi.fn()
      this.getClock = vi.fn()
      this.getAccountActivities = vi.fn()
    })
    await expect(acc.init()).rejects.toThrow('Authentication failed')
  })
})

describe('AlpacaAccount — searchContracts()', () => {
  it('returns empty array for empty pattern', async () => {
    const acc = new AlpacaAccount({ apiKey: 'k', secretKey: 's' })
    const results = await acc.searchContracts('')
    expect(results).toEqual([])
  })

  it('uppercases the pattern and returns a contract', async () => {
    const acc = new AlpacaAccount({ apiKey: 'k', secretKey: 's' })
    const results = await acc.searchContracts('aapl')
    expect(results).toHaveLength(1)
    expect(results[0].contract.symbol).toBe('AAPL')
  })
})

describe('AlpacaAccount — placeOrder()', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns success with orderId on filled order', async () => {
    const acc = new AlpacaAccount({ apiKey: 'k', secretKey: 's' })
    const { default: Alpaca } = await import('@alpacahq/alpaca-trade-api')
    ;(Alpaca as any).mockImplementationOnce(function (this: any) {
      this.getAccount = vi.fn()
      this.getPositions = vi.fn()
      this.createOrder = vi.fn().mockResolvedValue({
        id: 'ord-1',
        status: 'filled',
        filled_avg_price: '150.50',
        filled_qty: '10',
      })
      this.replaceOrder = vi.fn()
      this.cancelOrder = vi.fn()
      this.closePosition = vi.fn()
      this.getOrders = vi.fn()
      this.getSnapshot = vi.fn()
      this.getClock = vi.fn()
      this.getAccountActivities = vi.fn()
    })
    await acc.init().catch(() => {}) // init to set up client (will fail without mock account but client is created)
    // Directly inject client by triggering init on a partial mock
    const { default: AlpacaClass } = await import('@alpacahq/alpaca-trade-api')
    ;(acc as any).client = {
      createOrder: vi.fn().mockResolvedValue({
        id: 'ord-1', status: 'filled', filled_avg_price: '150.50', filled_qty: '10',
      }),
    }
    const result = await acc.placeOrder({
      contract: { aliceId: 'alpaca-AAPL', symbol: 'AAPL', secType: 'STK', exchange: 'NASDAQ', currency: 'USD' },
      side: 'buy',
      type: 'market',
      qty: 10,
    })
    expect(result.success).toBe(true)
    expect(result.orderId).toBe('ord-1')
    expect(result.filledPrice).toBe(150.50)
    expect(result.filledQty).toBe(10)
  })

  it('returns error when contract resolution fails', async () => {
    const acc = new AlpacaAccount({ apiKey: 'k', secretKey: 's' })
    ;(acc as any).client = { createOrder: vi.fn() }
    const result = await acc.placeOrder({
      contract: { aliceId: '', symbol: '', secType: 'STK', exchange: '', currency: '' },
      side: 'buy',
      type: 'market',
      qty: 1,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('Cannot resolve')
  })
})

describe('AlpacaAccount — getPositions()', () => {
  it('maps raw Alpaca positions to domain Position format', async () => {
    const acc = new AlpacaAccount({ apiKey: 'k', secretKey: 's' })
    ;(acc as any).client = {
      getPositions: vi.fn().mockResolvedValue([{
        symbol: 'AAPL',
        side: 'long',
        qty: '10',
        avg_entry_price: '150.00',
        current_price: '160.00',
        market_value: '1600.00',
        unrealized_pl: '100.00',
        unrealized_plpc: '0.0667',
        cost_basis: '1500.00',
      }]),
    }
    const positions = await acc.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].symbol).toBeUndefined() // fields are on contract
    expect(positions[0].contract.symbol).toBe('AAPL')
    expect(positions[0].qty).toBe(10)
    expect(positions[0].avgEntryPrice).toBe(150)
    expect(positions[0].currentPrice).toBe(160)
    expect(positions[0].marketValue).toBe(1600)
    expect(positions[0].unrealizedPnL).toBe(100)
    expect(Math.round(positions[0].unrealizedPnLPercent * 100) / 100).toBeCloseTo(6.67, 1)
    expect(positions[0].side).toBe('long')
  })
})

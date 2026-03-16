/**
 * CFTC COT (Commitments of Traders) Client
 *
 * Fetches weekly positioning data directly from CFTC's public Socrata API.
 * No API key required. Data released every Friday (as of prior Tuesday).
 *
 * Dataset: Legacy Futures-Only Report (6dca-aqww)
 * URL: https://publicreporting.cftc.gov/resource/6dca-aqww.json
 */

// ==================== Commodity Map ====================

/** Maps our shorthand to the CFTC market name fragment used in queries. */
const COMMODITY_MAP: Record<string, string> = {
  crude_oil:    'CRUDE OIL, LIGHT SWEET',
  natural_gas:  'NATURAL GAS',
  gold:         'GOLD',
  silver:       'SILVER',
  copper:       'COPPER-GRADE #1',
  wheat:        'WHEAT',
  corn:         'CORN',
  soybeans:     'SOYBEANS',
  coffee:       'COFFEE C',
  sugar:        'SUGAR NO. 11',
  cotton:       'COTTON NO. 2',
  lean_hogs:    'LEAN HOGS',
  live_cattle:  'LIVE CATTLE',
  feeder_cattle:'FEEDER CATTLE',
}

// ==================== Types ====================

export interface CotRecord {
  report_date: string
  market: string
  open_interest: number
  /** Non-commercial (managed money / speculators) */
  noncomm_long: number
  noncomm_short: number
  noncomm_net: number
  noncomm_net_chg: number
  /** Commercial (physical hedgers) */
  comm_long: number
  comm_short: number
  comm_net: number
  comm_net_chg: number
  /** Net as % of open interest */
  noncomm_net_pct: number
}

// ==================== Client ====================

export class CotClient {
  private readonly baseUrl = 'https://publicreporting.cftc.gov/resource'
  private readonly datasetId = '6dca-aqww' // Legacy Futures-Only

  /**
   * Fetch COT positioning for a commodity.
   * @param params.commodity  Shorthand key (e.g. 'crude_oil') or raw CFTC name fragment
   * @param params.weeks      Number of weekly reports to return (default 8)
   */
  async getCotData(params: Record<string, unknown> = {}): Promise<CotRecord[]> {
    const commodity = String(params.commodity ?? 'crude_oil')
    const weeks = Number(params.weeks ?? 8)

    const marketName = COMMODITY_MAP[commodity] ?? commodity.toUpperCase()
    const where = encodeURIComponent(`market_and_exchange_names like '%${marketName}%'`)
    const url = `${this.baseUrl}/${this.datasetId}.json?$where=${where}&$order=report_date_as_yyyy_mm_dd DESC&$limit=${weeks}`

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`CFTC API error ${res.status}: ${body.slice(0, 200)}`)
    }

    const raw = (await res.json()) as Record<string, string>[]
    return raw.map((r) => this.parseRecord(r))
  }

  private parseRecord(r: Record<string, string>): CotRecord {
    const ncLong  = Number(r.noncomm_positions_long_all  ?? 0)
    const ncShort = Number(r.noncomm_positions_short_all ?? 0)
    const cLong   = Number(r.comm_positions_long_all     ?? 0)
    const cShort  = Number(r.comm_positions_short_all    ?? 0)
    const oi      = Number(r.open_interest_all           ?? 0)
    const ncNet   = ncLong - ncShort
    const cNet    = cLong  - cShort

    return {
      report_date:     r.report_date_as_yyyy_mm_dd ?? '',
      market:          r.market_and_exchange_names ?? '',
      open_interest:   oi,
      noncomm_long:    ncLong,
      noncomm_short:   ncShort,
      noncomm_net:     ncNet,
      noncomm_net_chg: Number(r.change_in_noncomm_long_all ?? 0) - Number(r.change_in_noncomm_short_all ?? 0),
      comm_long:       cLong,
      comm_short:      cShort,
      comm_net:        cNet,
      comm_net_chg:    Number(r.change_in_comm_long_all ?? 0) - Number(r.change_in_comm_short_all ?? 0),
      noncomm_net_pct: oi > 0 ? Math.round((ncNet / oi) * 1000) / 10 : 0,
    }
  }
}

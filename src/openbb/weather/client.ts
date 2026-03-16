/**
 * Weather Client — Agricultural and energy weather data
 *
 * Uses NOAA Climate Data Online API (free, no key needed for basic endpoints)
 * and Open-Meteo API (completely free, no key needed).
 *
 * Key regions:
 * - US Corn Belt (Iowa: 42,-93)
 * - US Winter Wheat (Kansas: 38,-98)
 * - Black Sea Wheat (Odessa: 46,31)
 * - Brazil Coffee (Minas Gerais: -19,-44)
 * - US Natural Gas demand (Chicago: 41,-87 and New York: 40,-74)
 * - Gulf of Mexico (29,-90) for hurricane/storm impact on energy
 */

// ==================== Region Config ====================

type RegionKey = 'corn_belt' | 'winter_wheat' | 'black_sea' | 'brazil_coffee' | 'natural_gas_demand' | 'gulf'

const REGIONS: Record<RegionKey, { lat: number; lon: number; name: string }> = {
  corn_belt:          { lat: 42,  lon: -93, name: 'US Corn Belt (Iowa)' },
  winter_wheat:       { lat: 38,  lon: -98, name: 'US Winter Wheat (Kansas)' },
  black_sea:          { lat: 46,  lon:  31, name: 'Black Sea Wheat (Odessa)' },
  brazil_coffee:      { lat: -19, lon: -44, name: 'Brazil Coffee (Minas Gerais)' },
  natural_gas_demand: { lat: 41,  lon: -87, name: 'US Nat Gas Demand (Chicago)' },
  gulf:               { lat: 29,  lon: -90, name: 'Gulf of Mexico' },
}

const AGRI_REGIONS: RegionKey[] = ['corn_belt', 'winter_wheat', 'black_sea', 'brazil_coffee']

const HDD_CDD_CITIES: { name: string; lat: number; lon: number }[] = [
  { name: 'Chicago',  lat: 41.85, lon: -87.65 },
  { name: 'New York', lat: 40.71, lon: -74.01 },
  { name: 'Dallas',   lat: 32.78, lon: -96.80 },
  { name: 'Boston',   lat: 42.36, lon: -71.06 },
]

const BASE_TEMP_C = 18.3 // 65°F

// ==================== Types ====================

export interface RegionWeatherRecord {
  region: string
  lat: number
  lon: number
  current_temp_c: number
  temp_anomaly_desc: string
  precip_7d_mm: number
  forecast_summary: string
  weather_risk: 'drought risk' | 'frost risk' | 'flood risk' | 'normal'
}

export interface HddCddRecord {
  city: string
  hdd_7d: number
  cdd_7d: number
  demand_signal: 'high_heating' | 'high_cooling' | 'normal'
}

// ==================== Client ====================

export class WeatherClient {
  private readonly baseUrl = 'https://api.open-meteo.com/v1/forecast'

  /**
   * Fetch current + 7-day forecast for a named agricultural/energy region.
   * Returns a single-element array with region summary.
   */
  async getRegionWeather(params: Record<string, unknown> = {}): Promise<RegionWeatherRecord[]> {
    const regionKey = String(params.region ?? 'corn_belt') as RegionKey
    const regionCfg = REGIONS[regionKey]
    if (!regionCfg) return []

    try {
      const data = await this.fetchForecast(regionCfg.lat, regionCfg.lon)
      if (!data) return []

      const record = this.buildRegionRecord(regionKey, regionCfg, data)
      return [record]
    } catch {
      return []
    }
  }

  /**
   * Check all agricultural regions for notable weather anomalies.
   * Returns only regions with significant deviations (temp >5°C anomaly or extreme precip).
   */
  async getAgriculturalAlert(params: Record<string, unknown> = {}): Promise<RegionWeatherRecord[]> {
    const alerts: RegionWeatherRecord[] = []

    await Promise.all(AGRI_REGIONS.map(async (regionKey) => {
      const regionCfg = REGIONS[regionKey]
      try {
        const data = await this.fetchForecast(regionCfg.lat, regionCfg.lon)
        if (!data) return

        const record = this.buildRegionRecord(regionKey, regionCfg, data)

        // Only include regions with notable anomalies
        const isNotable = record.weather_risk !== 'normal'
          || Math.abs(record.current_temp_c - this.getSeasonalAvg(regionKey)) > 5
          || record.precip_7d_mm > 80

        if (isNotable) alerts.push(record)
      } catch {
        // skip failed region
      }
    }))

    return alerts
  }

  /**
   * Fetch heating/cooling degree days for major US cities (natural gas demand proxy).
   * HDD/CDD based on 65°F (18.3°C) base temperature over 7-day forecast.
   */
  async getHeatingCoolingDegrees(params: Record<string, unknown> = {}): Promise<HddCddRecord[]> {
    const results: HddCddRecord[] = []

    await Promise.all(HDD_CDD_CITIES.map(async (city) => {
      try {
        const data = await this.fetchForecast(city.lat, city.lon)
        if (!data) return

        const maxTemps: number[] = data.daily?.temperature_2m_max ?? []
        const minTemps: number[] = data.daily?.temperature_2m_min ?? []

        if (maxTemps.length === 0) return

        let hdd = 0
        let cdd = 0

        for (let i = 0; i < Math.min(maxTemps.length, 7); i++) {
          const avgTemp = ((maxTemps[i] ?? BASE_TEMP_C) + (minTemps[i] ?? BASE_TEMP_C)) / 2
          if (avgTemp < BASE_TEMP_C) {
            hdd += BASE_TEMP_C - avgTemp
          } else {
            cdd += avgTemp - BASE_TEMP_C
          }
        }

        hdd = Math.round(hdd * 10) / 10
        cdd = Math.round(cdd * 10) / 10

        let demand_signal: HddCddRecord['demand_signal'] = 'normal'
        if (hdd > 50) demand_signal = 'high_heating'
        else if (cdd > 30) demand_signal = 'high_cooling'

        results.push({ city: city.name, hdd_7d: hdd, cdd_7d: cdd, demand_signal })
      } catch {
        // skip failed city
      }
    }))

    return results
  }

  // ==================== Private Helpers ====================

  private async fetchForecast(lat: number, lon: number): Promise<Record<string, any> | null> {
    const url = `${this.baseUrl}?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
      `&forecast_days=7&timezone=auto`

    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null

    return await res.json() as Record<string, any>
  }

  private buildRegionRecord(
    regionKey: RegionKey,
    regionCfg: { lat: number; lon: number; name: string },
    data: Record<string, any>,
  ): RegionWeatherRecord {
    const maxTemps: number[] = data.daily?.temperature_2m_max ?? []
    const minTemps: number[] = data.daily?.temperature_2m_min ?? []
    const precipSums: number[] = data.daily?.precipitation_sum ?? []
    const weatherCodes: number[] = data.daily?.weathercode ?? []

    const currentTempC = maxTemps[0] != null && minTemps[0] != null
      ? Math.round(((maxTemps[0] + minTemps[0]) / 2) * 10) / 10
      : 0

    const totalPrecip7d = precipSums.reduce((s, v) => s + (v ?? 0), 0)
    const precipMm = Math.round(totalPrecip7d * 10) / 10

    // Determine weather risk
    let weather_risk: RegionWeatherRecord['weather_risk'] = 'normal'
    const seasonalAvg = this.getSeasonalAvg(regionKey)

    if (currentTempC < seasonalAvg - 5) {
      weather_risk = 'frost risk'
    } else if (precipMm < 5 && currentTempC > seasonalAvg + 3) {
      weather_risk = 'drought risk'
    } else if (precipMm > 80) {
      weather_risk = 'flood risk'
    }

    // Forecast summary from weather codes
    const forecast_summary = this.summarizeWeatherCodes(weatherCodes.slice(0, 7))
    const tempDiff = currentTempC - seasonalAvg
    const tempAnomalyDesc = Math.abs(tempDiff) < 2
      ? 'near seasonal average'
      : `${tempDiff > 0 ? '+' : ''}${tempDiff.toFixed(1)}°C vs seasonal avg`

    return {
      region: regionCfg.name,
      lat: regionCfg.lat,
      lon: regionCfg.lon,
      current_temp_c: currentTempC,
      temp_anomaly_desc: tempAnomalyDesc,
      precip_7d_mm: precipMm,
      forecast_summary,
      weather_risk,
    }
  }

  /**
   * Rough seasonal average temperatures (°C) by region.
   * Based on March/spring values for the current analysis period.
   */
  private getSeasonalAvg(regionKey: RegionKey): number {
    const month = new Date().getMonth() // 0-11
    const avgs: Record<RegionKey, number[]> = {
      corn_belt:          [-5, -3,  3,  11, 17, 22, 25, 24, 19, 12,  4, -3],
      winter_wheat:       [ 1,  3,  8,  14, 19, 25, 29, 28, 23, 16,  8,  2],
      black_sea:          [-1,  0,  5,  11, 17, 21, 24, 23, 18, 12,  6,  1],
      brazil_coffee:      [22, 23, 23, 22, 20, 18, 17, 18, 19, 20, 21, 22],
      natural_gas_demand: [-3, -1,  4,  10, 17, 22, 25, 24, 20, 13,  5, -1],
      gulf:               [14, 15, 18, 22, 26, 29, 30, 30, 28, 24, 19, 15],
    }
    return avgs[regionKey]?.[month] ?? 15
  }

  /**
   * Summarize WMO weather codes into a human-readable forecast string.
   * https://open-meteo.com/en/docs (weathercode field)
   */
  private summarizeWeatherCodes(codes: number[]): string {
    if (codes.length === 0) return 'No forecast data'

    const descriptions: string[] = codes.map((code) => {
      if (code === 0) return 'clear'
      if (code <= 3) return 'partly cloudy'
      if (code <= 49) return 'foggy'
      if (code <= 57) return 'drizzle'
      if (code <= 67) return 'rain'
      if (code <= 77) return 'snow'
      if (code <= 82) return 'rain showers'
      if (code <= 86) return 'snow showers'
      if (code <= 99) return 'thunderstorm'
      return 'unknown'
    })

    // Count most common condition
    const counts: Record<string, number> = {}
    for (const d of descriptions) {
      counts[d] = (counts[d] ?? 0) + 1
    }
    const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'mixed'
    const uniqueConditions = [...new Set(descriptions)].slice(0, 3).join(', ')

    return `7-day: mostly ${dominant} (${uniqueConditions})`
  }
}

/** Price path, volatility, 1-minute put pricing and the payout rule (the quant part). */
import { readFileSync } from 'node:fs'

/** Replay a CSV (column `price` or `Close`) or generate calm → nervous → crash → recovery. */
export function loadPrices (csvPath?: string, steps = 45, start = 30, seed = 7): number[] {
  if (csvPath !== undefined && csvPath !== '') {
    const [header, ...rows] = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/)
    const cols = header.split(',').map(c => c.trim())
    const i = cols.findIndex(c => ['price', 'Close', 'close'].includes(c))
    if (i === -1) throw new Error('CSV needs a "price" or "Close" column')
    return rows.map(r => Number(r.split(',')[i])).filter(Number.isFinite)
  }
  let s = seed
  const rand = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
  const path: number[] = []
  let p = start
  for (let t = 0; t < steps; t++) {
    const f = t / steps
    const [vol, drift] = f < 0.35 ? [0.0008, 0] : f < 0.55 ? [0.003, -0.001] : f < 0.72 ? [0.007, -0.01] : [0.003, 0.003]
    p *= Math.exp(drift + vol * gauss())
    path.push(Math.round(p * 10000) / 10000)
  }
  return path
}

/** Std-dev of 1-step log returns over the last `window` steps. */
export function perStepVol (prices: number[], window: number): number {
  const rets: number[] = []
  for (let i = Math.max(1, prices.length - window); i < prices.length; i++) rets.push(Math.log(prices[i] / prices[i - 1]))
  if (rets.length < 2) return 0.001
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  return Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1))
}

/** Downside-only volatility (negative returns), used for the volatility target. */
export function downsideVol (prices: number[], window: number): number {
  const rets: number[] = []
  for (let i = Math.max(1, prices.length - window); i < prices.length; i++) rets.push(Math.min(0, Math.log(prices[i] / prices[i - 1])))
  if (rets.length < 2) return 0
  return Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length)
}

function normCdf (x: number): number {
  // Abramowitz-Stegun approximation of the standard normal CDF
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989423 * Math.exp(-x * x / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x > 0 ? 1 - p : p
}

/** Black-Scholes put, r = 0, T = 1 step, per 1 unit of the asset (USD). */
export function putOneStep (price: number, strike: number, vol: number): number {
  const s = Math.max(vol, 1e-6)
  const d1 = (Math.log(price / strike) + 0.5 * s * s) / s
  return strike * normCdf(-(d1 - s)) - price * normCdf(-d1)
}

/** Each covered minute only pays NEW losses below the floor: strike = min(floor, current price). */
export const strikeFor = (price: number, floor: number): number => Math.min(floor, price)

/** Fair premium in sats for protecting `sats` of BSV for one step. */
export function fairPremiumSats (sats: number, price: number, floor: number, vol: number): number {
  return sats * putOneStep(price, strikeFor(price, floor), vol) / price
}

/**
 * Payout in sats that restores the dollar value lost below the floor during one step:
 * loss in USD = sats/1e8 * (strike - next), paid at the new price.
 */
export function payoutSats (sats: number, price: number, next: number, floor: number): number {
  const strike = strikeFor(price, floor)
  return next < strike ? Math.round(sats * (strike - next) / next) : 0
}

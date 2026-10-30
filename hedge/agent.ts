/**
 * The buyer agent: keeps its BSV treasury's dollar value stable by buying protection minute by minute.
 *
 * Math tools compute the numbers (fair value, suggested cover). An LLM (Groq, optional) makes the
 * judgment call. The LLM only PROPOSES: the SafetyLayer and the SpendGuard wallet in code DECIDE
 * what can actually be paid, whatever the LLM or the seller says.
 */
import { appendFileSync } from 'node:fs'
import { AuthFetch, type WalletInterface } from '@bsv/sdk'
import { acceptBrc29Payment, type Brc29Payment } from '../client/payments'
import { CONFIG } from './config'
import { downsideVol, fairPremiumSats, perStepVol } from './market'

// ---------------------------------------------------------------- safety

/**
 * Wraps the wallet: createAction is refused unless the payment fits the allowance the
 * SafetyLayer approved for THIS purchase. AuthFetch pays whatever a 402 asks for, so this
 * is what stops a seller (or a prompt injection) from charging more than was approved.
 */
export class SpendGuard {
  private allowance = 0
  constructor (private readonly inner: WalletInterface) {}
  allow (sats: number): void { this.allowance = sats }
  get wallet (): WalletInterface {
    return new Proxy(this.inner, {
      get: (target, prop, receiver) => {
        const value = Reflect.get(target, prop, receiver)
        if (prop !== 'createAction' || typeof value !== 'function') return typeof value === 'function' ? value.bind(target) : value
        return async (args: any, originator?: string) => {
          const total = (args?.outputs ?? []).reduce((s: number, o: any) => s + Number(o.satoshis ?? 0), 0)
          if (total > this.allowance) throw new Error(`SpendGuard: ${total} sats requested, only ${this.allowance} approved`)
          this.allowance = 0 // one approval = one payment
          return await value.call(target, args, originator)
        }
      }
    })
  }
}

export class SafetyLayer {
  spent = 0
  private readonly paidSteps = new Set<number>()
  constructor (readonly budget: number, readonly maxPurchase: number, readonly allowedSeller: string) {}

  check (step: number, premium: number, sellerKey: string): string | null {
    if (this.paidSteps.has(step)) return 'already paid this minute (idempotency)'
    if (this.allowedSeller !== '' && sellerKey !== this.allowedSeller) return 'seller not on allowlist'
    if (premium > this.maxPurchase) return `premium ${premium} > max purchase ${this.maxPurchase}`
    if (this.spent + premium > this.budget) return `budget exhausted (${this.spent}/${this.budget})`
    return null
  }

  record (step: number, premium: number): void { this.paidSteps.add(step); this.spent += premium }
}

// ---------------------------------------------------------------- decision

export interface State {
  step: number, price: number, floor: number, distanceToFloorPct: number, volPct: number,
  suggestedCover: number, quotePremium: number, quoteMinutes: number, fairEstimateSats: number,
  riskAversion: number, budgetLeft: number
}
export interface Decision { action: 'buy' | 'skip', cover: number, reason: string, by: 'llm' | 'rule' }

/** Suggested cover: full cover, or only the share of downside volatility above the user's target. */
export function suggestedCover (prices: number[]): number {
  if (CONFIG.targetVolPct <= 0) return 1
  const dv = downsideVol(prices, 10) * 100
  return dv <= 0 ? 0 : Math.max(0, Math.min(1, 1 - CONFIG.targetVolPct / dv))
}

export function rulePolicy (s: State): Decision {
  const perMinute = s.quotePremium / Math.max(1, s.quoteMinutes)
  const limit = Math.max(s.fairEstimateSats * s.riskAversion, 2 * CONFIG.minPremiumSats)
  if (s.suggestedCover === 0) return { action: 'skip', cover: 0, reason: 'downside volatility below the user target', by: 'rule' }
  if (perMinute <= 0.0005 * CONFIG.protectSats * s.suggestedCover) return { action: 'buy', cover: s.suggestedCover, reason: `negligible premium (${perMinute.toFixed(0)} sats/min), staying covered`, by: 'rule' }
  if (perMinute <= limit) return { action: 'buy', cover: s.suggestedCover, reason: `${perMinute.toFixed(0)} sats/min <= limit ${limit.toFixed(0)}`, by: 'rule' }
  if (s.distanceToFloorPct < 1) return { action: 'buy', cover: s.suggestedCover, reason: `pricey (${perMinute.toFixed(0)} > ${limit.toFixed(0)}) but within 1% of the floor`, by: 'rule' }
  return { action: 'skip', cover: 0, reason: `${perMinute.toFixed(0)} sats/min > limit ${limit.toFixed(0)}, far from floor`, by: 'rule' }
}

const SYSTEM_PROMPT = `You are an AI agent that pays for services in BSV. Your costs are in dollars, so a falling BSV price
shrinks your budget. Each minute you may buy downside protection that pays you the dollar value lost below a fixed floor.

UNITS: every amount is given in BOTH satoshis ("sats", 1 BSV = 100,000,000 sats) and US dollars ("usd").
Compare like with like: premium usd vs expected payout usd. Never treat sats as dollars.

"myFairValueEstimate" is the expected payout of ONE minute of protection (what it is statistically worth).
Paying somewhat above fair value is the normal cost of insurance: buying is reasonable while the per-minute premium is
at most riskAversion x fair value. Close to or below the floor, or when volatility is rising, protection matters most:
avoid dropping it exactly when a crash becomes likely. Far above the floor in a calm market, skip if it is overpriced.
If the per-minute premium is negligible compared to the protected treasury (premiumPctOfTreasury below 0.05%),
KEEP protection on even if it is many times fair value: being uncovered when a crash starts is far more costly.
Dropping protection is expensive: re-entering requires prepaying several minutes at once (minutesCovered).
Judge the PER-MINUTE price.
Reply ONLY with JSON:
{"action":"buy"|"skip","cover":<0..1, fraction of the treasury to protect>,"reason":"<one short sentence>"}`

/** What the LLM sees: every amount labelled with its unit, in sats AND dollars. */
export function llmView (s: State): Record<string, unknown> {
  const usd = (sats: number): number => Number((sats * s.price / 1e8).toFixed(6))
  const perMinute = s.quotePremium / Math.max(1, s.quoteMinutes)
  return {
    step: s.step,
    bsvPriceUsd: s.price,
    floorPriceUsd: s.floor,
    distanceToFloorPct: s.distanceToFloorPct,
    volatilityPerMinutePct: s.volPct,
    treasuryProtected: { sats: Math.round(CONFIG.protectSats * s.suggestedCover), usd: usd(CONFIG.protectSats * s.suggestedCover) },
    quote: { totalSats: s.quotePremium, totalUsd: usd(s.quotePremium), minutesCovered: s.quoteMinutes, perMinuteSats: perMinute, perMinuteUsd: usd(perMinute) },
    myFairValueEstimate: { perMinuteSats: s.fairEstimateSats, perMinuteUsd: usd(s.fairEstimateSats) },
    premiumToFairRatio: s.fairEstimateSats > 0 ? Number((perMinute / s.fairEstimateSats).toFixed(2)) : null,
    premiumPctOfTreasury: Number((perMinute / Math.max(1, CONFIG.protectSats * s.suggestedCover) * 100).toFixed(4)),
    riskAversion: s.riskAversion,
    budgetLeft: { sats: s.budgetLeft, usd: usd(s.budgetLeft) },
    suggestedCover: s.suggestedCover
  }
}

export async function decide (s: State): Promise<Decision> {
  const key = process.env.GROQ_API_KEY
  if (key === undefined || key === '' || process.env.NO_LLM === '1') return rulePolicy(s)
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: CONFIG.groqModel, temperature: 0.2, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(llmView(s)) }] })
    })
    if (!res.ok) throw new Error(`Groq ${res.status}`)
    const text: string = (await res.json()).choices[0].message.content
    const d = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    if (d.action !== 'buy' && d.action !== 'skip') throw new Error('bad action')
    return { action: d.action, cover: Math.max(0, Math.min(1, Number(d.cover ?? 1))), reason: String(d.reason ?? ''), by: 'llm' }
  } catch (e) {
    const r = rulePolicy(s)
    return { ...r, reason: `${r.reason} (LLM unavailable: ${(e as Error).message})` }
  }
}

// ---------------------------------------------------------------- loop

export interface AgentResult { premiums: number, payouts: number, purchases: number, payoutTxids: string[], premiumTxids: string[], startPrice: number, endPrice: number }

export async function runAgent (wallet: WalletInterface, opts: { log?: string, waitMs?: number, chainTracker?: any } = {}): Promise<AgentResult> {
  const guard = new SpendGuard(wallet)
  const client = new AuthFetch(guard.wallet)
  const safety = new SafetyLayer(CONFIG.budgetSats, CONFIG.maxPurchaseSats, CONFIG.sellerIdentityKey)
  const url = CONFIG.sellerUrl
  const result: AgentResult = { premiums: 0, payouts: 0, purchases: 0, payoutTxids: [], premiumTxids: [], startPrice: 0, endPrice: 0 }
  const waitMs = opts.waitMs ?? 1000
  let lastStep = -1
  let steps = 0

  const collectPayouts = async (): Promise<void> => {
    const res = await client.fetch(`${url}/protection/payouts`)
    for (const p of await res.json() as Brc29Payment[]) {
      await acceptBrc29Payment(wallet, p, opts.chainTracker, 'Protection payout') // verify (SPV) + internalize
      result.payouts += p.satoshis
      result.payoutTxids.push(p.txid)
      console.log(`  💰 payout received: ${p.satoshis} sats  https://whatsonchain.com/tx/${p.txid}`)
    }
  }

  for (;;) {
    const m = await (await fetch(`${url}/market`)).json()
    if (result.startPrice === 0) result.startPrice = m.price
    result.endPrice = m.price
    if (m.done || (CONFIG.maxSteps > 0 && steps >= CONFIG.maxSteps)) break
    if (m.step === lastStep) { await new Promise(r => setTimeout(r, waitMs)); continue }
    lastStep = m.step
    steps++
    await collectPayouts()

    const cover = suggestedCover(m.history)
    const quote = await (await client.fetch(`${url}/protection/quote?sats=${Math.round(CONFIG.protectSats * cover)}`)).json()
    const fair = fairPremiumSats(CONFIG.protectSats * cover, m.price, quote.floor, perStepVol(m.history, 10)) // agent's OWN estimate
    const state: State = {
      step: m.step, price: m.price, floor: Number(quote.floor.toFixed(4)), distanceToFloorPct: Number(((m.price / quote.floor - 1) * 100).toFixed(3)),
      volPct: Number((perStepVol(m.history, 10) * 100).toFixed(3)), suggestedCover: Number(cover.toFixed(2)),
      quotePremium: quote.premium, quoteMinutes: quote.minutes, fairEstimateSats: Number(fair.toFixed(1)),
      riskAversion: CONFIG.riskAversion, budgetLeft: CONFIG.budgetSats - safety.spent
    }
    const d = await decide(state)
    const event: Record<string, unknown> = { ...state, decision: d }

    if (d.action === 'buy' && quote.premium > 0) {
      // if the LLM chose a different cover, re-quote so the SERVER prices exactly what we buy
      const q = Math.abs(d.cover - cover) > 0.05
        ? await (await client.fetch(`${url}/protection/quote?sats=${Math.round(CONFIG.protectSats * d.cover)}`)).json()
        : quote
      const blocked = safety.check(m.step, q.premium, q.sellerIdentityKey)
      if (blocked !== null) {
        event.blocked = blocked
      } else {
        guard.allow(q.premium)
        try {
          const res = await client.fetch(`${url}/protection/buy?quoteId=${q.id}`) // 402 → pay → 200
          const body = await res.json()
          if (!res.ok) throw new Error(body.description ?? body.error ?? `HTTP ${res.status}`)
          safety.record(m.step, q.premium)
          result.premiums += q.premium
          result.purchases++
          result.premiumTxids.push(body.txid)
          event.premiumTx = body.txid
          event.covered = body.covered
        } catch (e) {
          event.blocked = `payment failed: ${(e as Error).message}`
        } finally {
          guard.allow(0)
        }
      }
    }

    const tag = event.premiumTx !== undefined ? `PAID ${quote.premium}` : (event.blocked !== undefined ? `BLOCKED (${String(event.blocked)})` : 'skip')
    console.log(`step ${m.step}  $${Number(m.price).toFixed(4)}  vol ${state.volPct}%  quote ${quote.premium} sats/${quote.minutes}min  → ${d.action} [${d.by}] ${tag}\n    reason: ${d.reason}`)
    if (event.premiumTx !== undefined) console.log(`    https://whatsonchain.com/tx/${String(event.premiumTx)}`)
    if (opts.log !== undefined) appendFileSync(opts.log, JSON.stringify(event) + '\n')
  }
  await collectPayouts()
  return result
}

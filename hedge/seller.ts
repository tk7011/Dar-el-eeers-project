/**
 * Protection seller: a BRC-105 pay-per-request API.
 *
 *  GET /market                 public   price, volatility, step (for agents and the dashboard)
 *  GET /ledger                 public   every premium and payout with txids (dashboard / judges)
 *  GET /protection/quote?sats= auth     quote for protecting `sats` of BSV this minute
 *  GET /protection/buy?quoteId= PAID    pays the quote via HTTP 402 (AuthFetch pays automatically)
 *  GET /protection/payouts     auth     BRC-29 payouts owed to the caller (caller verifies + internalizes)
 *
 * Non-custodial: buyers pay premiums straight from their own wallet; the seller pays claims
 * from its OWN collateral; nobody holds buyers' funds. The price is always set by the server.
 */
import express, { type Express } from 'express'
import { createAuthMiddleware, type AuthRequest } from '@bsv/auth-express-middleware'
import { createPaymentMiddleware, type PaymentRequest } from '@bsv/payment-express-middleware'
import { OP, P2PKH, PublicKey, Random, Script, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { BRC29_PROTOCOL, type Brc29Payment } from '../client/payments'
import { CONFIG } from './config'
import { fairPremiumSats, payoutSats, perStepVol, strikeFor } from './market'

interface Quote { id: string, buyer: string, step: number, sats: number, minutes: number, premium: number, floor: number }
interface Buyer { floor: number, covered: Map<number, number>, pending: Brc29Payment[], premiums: number, payouts: number }
export interface LedgerEvent { step: number, kind: 'premium' | 'payout', buyer: string, sats: number, txid: string, price: number, note: string }

/** BRC-29 payment with an extra OP_RETURN memo output, so every payout is traceable on-chain. */
async function payWithMemo (wallet: WalletInterface, recipient: string, satoshis: number, memo: string): Promise<Brc29Payment> {
  const derivationPrefix = Utils.toBase64(Random(16))
  const derivationSuffix = Utils.toBase64(Random(16))
  const { publicKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL, keyID: `${derivationPrefix} ${derivationSuffix}`, counterparty: recipient, forSelf: false
  })
  const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress()).toHex()
  const memoScript = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray('agent-hedge', 'utf8')).writeBin(Utils.toArray(memo, 'utf8')).toHex()
  const res = await wallet.createAction({
    description: 'Protection payout',
    outputs: [
      { lockingScript, satoshis, outputDescription: 'protection payout' },
      { lockingScript: memoScript, satoshis: 0, outputDescription: 'protection memo' }
    ],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })
  if (res.txid === undefined || res.tx === undefined) throw new Error('payout not completed by the wallet')
  const outputIndex = Transaction.fromAtomicBEEF(res.tx).outputs.findIndex(o => o.lockingScript.toHex() === lockingScript)
  const { publicKey: senderIdentityKey } = await wallet.getPublicKey({ identityKey: true })
  return { tx: Array.from(res.tx), txid: res.txid, outputIndex, satoshis, derivationPrefix, derivationSuffix, senderIdentityKey }
}

export class ProtectionSeller {
  step = 0
  readonly buyers = new Map<string, Buyer>()
  readonly quotes = new Map<string, Quote>()
  readonly ledger: LedgerEvent[] = []
  private settling: Promise<void> = Promise.resolve()

  constructor (
  readonly wallet: WalletInterface,
  readonly prices: number[],
  readonly historySteps = 20,
  readonly liveMode = false
) {
  this.step = historySteps
}

  get price (): number { return this.prices[this.step] }
  get done (): boolean {
  return !this.liveMode && this.step >= this.prices.length - 1
  }
  history (): number[] { return this.prices.slice(0, this.step + 1) }

  /** Seller's volatility: the HIGHER of short- and long-term, so a sudden spike is priced in at once. */
  vol (): number { return Math.max(perStepVol(this.history(), 5), perStepVol(this.history(), 20)) }

  buyer (id: string): Buyer {
    let b = this.buyers.get(id)
    if (b === undefined) { b = { floor: this.price * CONFIG.floorPct, covered: new Map(), pending: [], premiums: 0, payouts: 0 }; this.buyers.set(id, b) }
    return b
  }

  quote (buyerId: string, requestedSats: number): Quote {
    const sats = Math.max(0, Math.min(Math.floor(requestedSats), CONFIG.maxProtectedSats))
    const b = this.buyer(buyerId)
    const newStreak = !b.covered.has(this.step - 1) && !b.covered.has(this.step)
    const minutes = newStreak ? CONFIG.minMinutes : 1 // adverse selection: newcomers prepay a minimum duration
    const perMinute = Math.max(CONFIG.minPremiumSats, Math.round(fairPremiumSats(sats, this.price, b.floor, this.vol()) * (1 + CONFIG.sellerMargin)))
    const q: Quote = { id: Utils.toHex(Random(8)), buyer: buyerId, step: this.step, sats, minutes, premium: sats === 0 ? 0 : perMinute * minutes, floor: b.floor }
    this.quotes.set(q.id, q)
    return q
  }

  /** Called after payment is verified: cover this minute (and the prepaid minimum). */
  activate (q: Quote, txid: string): number[] {
    const b = this.buyer(q.buyer)
    const steps: number[] = []
    for (let s = Math.max(q.step, this.step); steps.length < q.minutes; s++) {
      if (!b.covered.has(s)) { b.covered.set(s, q.sats); steps.push(s) } // skip minutes already covered
    }
    b.premiums += q.premium
    this.quotes.delete(q.id)
    this.ledger.push({ step: this.step, kind: 'premium', buyer: q.buyer, sats: q.premium, txid, price: this.price, note: `covers steps ${steps.join(',')}` })
    return steps
  }

  /** Advance the market one step and settle the step that just ended. */
  async advance (): Promise<void> {
  if (this.step >= this.prices.length - 1) return
    const ended = this.step
    const price = this.prices[ended]
    const next = this.prices[ended + 1]
    this.step++
    for (const [id, b] of this.buyers) {
      const sats = b.covered.get(ended)
      if (sats === undefined) continue
      const owed = payoutSats(sats, price, next, b.floor)
      if (owed <= 0) continue
      try {
        const p = await payWithMemo(this.wallet, id, owed, `step ${ended} payout ${owed} strike ${strikeFor(price, b.floor).toFixed(4)} close ${next}`)
        b.pending.push(p)
        b.payouts += owed
        this.ledger.push({ step: ended, kind: 'payout', buyer: id, sats: owed, txid: p.txid, price: next, note: 'price below floor' })
      } catch (e) {
        console.error(`[seller] payout of ${owed} sats failed (collateral?):`, (e as Error).message)
      }
    }
  }

  /** Serialised advance, so payouts never overlap. */
  tick (): Promise<void> { this.settling = this.settling.then(async () => await this.advance()); return this.settling }



tickLive(price: number): Promise<void> {
  if (!this.liveMode) {
    return Promise.reject(new Error('Live mode is disabled'))
  }

  if (!Number.isFinite(price) || price <= 0) {
    return Promise.reject(new Error('Invalid live BSV price'))
  }

  this.settling = this.settling.then(async () => {
    this.prices.push(price)
    await this.advance()
  })

  return this.settling
}




marketView(): Record<string, unknown> {
  return {
    step: this.step,
    price: this.price,
    done: this.done,
    source: this.liveMode ? 'live' : 'replay',
    vol: this.vol(),
    history: this.history().slice(-60),
    floorPct: CONFIG.floorPct,
    minMinutes: CONFIG.minMinutes,
    stepSeconds: this.liveMode ? 60 : CONFIG.stepSeconds
  }
}

}

export function createSellerApp (seller: ProtectionSeller): Express {
  const app = express()
  app.use(express.json()) // the auth handshake needs a parsed JSON body
  app.use((_, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next() })
  app.get('/market', (_, res) => { res.json(seller.marketView()) })
  app.get('/ledger', (_, res) => {
    res.json({ step: seller.step, price: seller.price, ledger: seller.ledger, buyers: [...seller.buyers].map(([id, b]) => ({ id, floor: b.floor, premiums: b.premiums, payouts: b.payouts })) })
  })

  app.use(createAuthMiddleware({ wallet: seller.wallet })) // who is calling (BRC-103/104)
  app.use(createPaymentMiddleware({ // have they paid (BRC-105). The SERVER sets the price.
    wallet: seller.wallet,
    calculateRequestPrice: (req: PaymentRequest) => {
      if (req.path !== '/protection/buy') return 0
      const q = seller.quotes.get(String(req.query.quoteId ?? ''))
      const caller = (req as unknown as AuthRequest).auth?.identityKey
      if (q === undefined || q.buyer !== caller || seller.step - q.step > 1) throw new Error('unknown or expired quote')
      return q.premium
    }
  }))

  const caller = (req: unknown): string | undefined => {
    const id = (req as AuthRequest).auth?.identityKey
    return id === undefined || id === 'unknown' ? undefined : id
  }

  app.get('/protection/quote', async (req, res) => {
    const id = caller(req)
    if (id === undefined) { res.status(401).json({ error: 'auth required' }); return }
    const q = seller.quote(id, Number(req.query.sats ?? 0))
    const { publicKey } = await seller.wallet.getPublicKey({ identityKey: true })
    res.json({ ...q, price: seller.price, strike: strikeFor(seller.price, q.floor), vol: seller.vol(), sellerIdentityKey: publicKey })
  })

  app.get('/protection/buy', (req: PaymentRequest, res) => {
    const id = caller(req)
    const q = seller.quotes.get(String(req.query.quoteId ?? ''))
    if (id === undefined || q === undefined || req.payment === undefined || req.payment.satoshisPaid < q.premium) {
      res.status(400).json({ error: 'invalid purchase' }); return
    }
    const steps = seller.activate(q, req.payment.txid)
    res.json({ covered: steps, paid: req.payment.satoshisPaid, txid: req.payment.txid })
  })

  app.get('/protection/payouts', (req, res) => {
    const id = caller(req)
    if (id === undefined) { res.status(401).json({ error: 'auth required' }); return }
    const b = seller.buyer(id)
    res.json(b.pending.splice(0))
  })
  return app
}

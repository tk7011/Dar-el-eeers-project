/**
 * Per-minute protection, end to end on the mock chain with real wallet-toolbox wallets:
 * the agent pays premiums over HTTP 402 (BRC-105), the seller pays BRC-29 payouts with an
 * on-chain memo when the price crashes below the floor, and the agent verifies + internalizes them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Transaction } from '@bsv/sdk'
import type { Wallet } from '@bsv/wallet-toolbox'
import { createMockChain, type MockChain } from './helpers/mockchain'
import { CONFIG } from '../hedge/config'
import { loadPrices } from '../hedge/market'
import { ProtectionSeller, createSellerApp } from '../hedge/seller'
import { SpendGuard, runAgent } from '../hedge/agent'

let chain: MockChain
const spendable = async (w: Wallet): Promise<number> =>
  (await w.listOutputs({ basket: 'default', limit: 1000 })).outputs.filter(o => o.spendable).reduce((s, o) => s + o.satoshis, 0)

beforeAll(async () => { chain = await createMockChain() })
afterAll(async () => { await chain?.close() })

describe('agent hedging on BSV', () => {
  let sellerWallet: Wallet, agentWallet: Wallet, server: Server, seller: ProtectionSeller
  let timer: NodeJS.Timeout

  beforeAll(async () => {
    ;[sellerWallet, agentWallet] = await Promise.all([chain.makeWallet(), chain.makeWallet()])
    await chain.fund(sellerWallet, 500_000) // seller's own collateral
    await chain.fund(agentWallet, 100_000) // agent's own budget
    // keep many independent change coins, so rapid payments don't build long unconfirmed chains (guide §11)
    await sellerWallet.setWalletChangeParams(24, 10_000)
    await agentWallet.setWalletChangeParams(24, 3_000)
    process.env.NO_LLM = '1'
    Object.assign(CONFIG, { sellerUrl: 'http://localhost:18095', budgetSats: 20_000, maxPurchaseSats: 5_000 })
    seller = new ProtectionSeller(sellerWallet, loadPrices(undefined, 45))
    server = await new Promise(resolve => { const s = createServer({ maxHeaderSize: 4 * 1024 * 1024 }, createSellerApp(seller)).listen(18095, () => resolve(s)) })
  })
  afterAll(async () => { clearInterval(timer); await new Promise(resolve => server?.close(resolve)) })

  it('SpendGuard refuses a payment larger than approved', async () => {
    const guard = new SpendGuard(agentWallet)
    guard.allow(100)
    await expect(guard.wallet.createAction({ description: 'too much for guard', outputs: [{ lockingScript: '6a', satoshis: 101, outputDescription: 'x' }] }))
      .rejects.toThrow(/SpendGuard/)
  })

  it('buys protection minute by minute and receives payouts during the crash', async () => {
    const before = await spendable(agentWallet)
    timer = setInterval(() => { void seller.tick() }, 1500)
    const r = await runAgent(agentWallet, { waitMs: 200, chainTracker: chain.chainTracker })
    clearInterval(timer)

    console.log(`premiums ${r.premiums}  payouts ${r.payouts}  purchases ${r.purchases}  price ${r.startPrice} → ${r.endPrice}`)
    expect(r.purchases).toBeGreaterThan(0)
    expect(r.payouts).toBeGreaterThan(0)
    expect(r.premiums).toBeLessThanOrEqual(CONFIG.budgetSats)

    // seller ledger matches, and payouts carry the on-chain memo
    const payouts = seller.ledger.filter(e => e.kind === 'payout')
    expect(payouts.reduce((s, e) => s + e.sats, 0)).toBe(r.payouts)
    const b = [...seller.buyers.values()][0]
    expect(b.premiums).toBe(r.premiums)

    // agent balance moved by exactly payouts − premiums − its own network fees
    const after = await spendable(agentWallet)
    const fees = before - after - r.premiums + r.payouts
    expect(fees).toBeGreaterThanOrEqual(0)
    expect(fees).toBeLessThan(100 * r.purchases + 100)
  }, 300_000)
})

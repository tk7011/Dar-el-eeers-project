/**
 * Start the buyer agent:
 *   npx tsx hedge/run-agent.ts             agent pays from its own server wallet (fund it with hedge/fund.ts or the dashboard)
 *   npx tsx hedge/run-agent.ts desktop     agent pays from YOUR BSV Desktop wallet (you approve spending there)
 *   npx tsx hedge/run-agent.ts --wait      wait until "Start agent" is clicked on the dashboard
 *
 * It also serves http://localhost:8091 for the dashboard:
 *   GET /info     identity key, balance, settings, status
 *   GET /events   every decision (with the LLM's reason) and every payout
 *   POST /fund    a BRC-29 payment made by the user's BSV Desktop → verified and internalized (non-custodial funding)
 *   POST /start   start the run (with --wait)
 * Every decision is also appended to hedge-events.jsonl.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { acceptBrc29Payment, type Brc29Payment } from '../client/payments'
import { CONFIG } from './config'
import { runAgent } from './agent'
import { balance, desktopWallet, serverWallet } from './wallets'

const useDesktop = process.argv.includes('desktop')
const waitForStart = process.argv.includes('--wait')
const AGENT_PORT = Number(process.env.AGENT_PORT ?? 8091)

const wallet = useDesktop ? await desktopWallet() : await serverWallet('AGENT_PRIVATE_KEY', 24, 3_000, true)
const { publicKey: identityKey } = await wallet.getPublicKey({ identityKey: true })
const events: Array<Record<string, unknown>> = []
let status: 'waiting' | 'running' | 'finished' = waitForStart ? 'waiting' : 'running'
let summary: Record<string, unknown> | null = null
let start: () => void = () => {}
const started = new Promise<void>(resolve => { start = resolve })
if (!waitForStart) start()

const send = (res: ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  })
  res.end(JSON.stringify(body))
}
const readJson = async (req: IncomingMessage): Promise<any> => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return JSON.parse(raw)
}

createServer({ maxHeaderSize: 4 * 1024 * 1024 }, (req, res) => {
  void (async () => {
    try {
      if (req.method === 'OPTIONS') return send(res, 204, {})
      if (req.method === 'GET' && req.url === '/info') {
        return send(res, 200, {
          identityKey, wallet: useDesktop ? 'BSV Desktop' : 'server wallet', balance: await balance(wallet), status, summary,
          settings: { protectSats: CONFIG.protectSats, budgetSats: CONFIG.budgetSats, maxPurchaseSats: CONFIG.maxPurchaseSats, riskAversion: CONFIG.riskAversion, sellerUrl: CONFIG.sellerUrl }
        })
      }
      if (req.method === 'GET' && req.url === '/events') return send(res, 200, events)
      if (req.method === 'POST' && req.url === '/fund') {
        const payment = await readJson(req) as Brc29Payment
        if (!Number.isInteger(payment?.satoshis) || payment.satoshis <= 0 || payment.satoshis > 1_000_000) return send(res, 400, { error: 'invalid amount' })
        await acceptBrc29Payment(wallet, payment, undefined, 'Funding from owner (dashboard)') // verifies it is really ours
        events.push({ kind: 'funding', sats: payment.satoshis, txid: payment.txid, time: Date.now() })
        console.log(`Funded from BSV Desktop: ${payment.satoshis} sats  https://whatsonchain.com/tx/${payment.txid}`)
        return send(res, 200, { ok: true, balance: await balance(wallet) })
      }
      if (req.method === 'POST' && req.url === '/start') {
        if (status === 'waiting') { status = 'running'; start() }
        return send(res, 200, { status })
      }
      send(res, 404, { error: 'not found' })
    } catch (e) {
      send(res, 500, { error: (e as Error).message })
    }
  })()
}).listen(AGENT_PORT, () => console.log(`Agent API for the dashboard on http://localhost:${AGENT_PORT}`))

console.log(`Agent wallet: ${useDesktop ? 'BSV Desktop' : 'server wallet'}, balance ${await balance(wallet)} sats, identity ${identityKey}`)
console.log(`Protecting ${CONFIG.protectSats} sats, premium budget ${CONFIG.budgetSats}, max ${CONFIG.maxPurchaseSats}/purchase, LLM: ${process.env.GROQ_API_KEY !== undefined && process.env.NO_LLM !== '1' ? 'on' : 'off (rules)'}\n`)
if (waitForStart) console.log('Waiting for "Start agent" on the dashboard…')
await started

const r = await runAgent(wallet, { log: 'hedge-events.jsonl', onEvent: e => events.push(e) })
status = 'finished'
const usd = (sats: number, price: number): number => sats * price / 1e8
summary = {
  startPrice: r.startPrice, endPrice: r.endPrice, premiums: r.premiums, payouts: r.payouts, purchases: r.purchases,
  unprotectedUsd: [usd(CONFIG.protectSats, r.startPrice), usd(CONFIG.protectSats, r.endPrice)],
  protectedUsd: [usd(CONFIG.protectSats, r.startPrice), usd(CONFIG.protectSats + r.payouts - r.premiums, r.endPrice)]
}
console.log('\n=== Summary ===')
console.log(`BSV price: $${r.startPrice} → $${r.endPrice}`)
console.log(`Premiums paid ${r.premiums} sats in ${r.purchases} purchases · payouts received ${r.payouts} sats`)
console.log(`Treasury value unprotected: $${usd(CONFIG.protectSats, r.startPrice).toFixed(4)} → $${usd(CONFIG.protectSats, r.endPrice).toFixed(4)}`)
console.log(`Treasury value protected:   $${usd(CONFIG.protectSats, r.startPrice).toFixed(4)} → $${usd(CONFIG.protectSats + r.payouts - r.premiums, r.endPrice).toFixed(4)}`)
console.log('\nThe dashboard API stays up so the results remain visible. Press Ctrl+C to quit.')

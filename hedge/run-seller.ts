/**
 * Start the protection seller on mainnet.
 *
 *   npx tsx hedge/run-seller.ts [prices.csv]        replay mode (default): scripted BSV crash, starts with the first buyer
 *   PRICE_MODE=live npx tsx hedge/run-seller.ts     live BSV/USD from CoinGecko, one step per minute (read-only)
 *   PRICE_MODE=live LIVE_TRADING=1 …                live prices AND real protection sales
 *
 * The ledger (every premium and payout txid) is saved to hedge-ledger-<time>.json after every step.
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { CONFIG } from './config'
import { loadPrices } from './market'
import { ProtectionSeller, createSellerApp } from './seller'
import { balance, serverWallet } from './wallets'
import { fetchLiveBsvPrice, fetchBsvHistory } from './live-price'

const mode = process.env.PRICE_MODE ?? 'replay'
const liveTrading = process.env.LIVE_TRADING === '1'
const LIVE_INTERVAL_SECONDS = 60

if (mode !== 'replay' && mode !== 'live') {
  throw new Error('PRICE_MODE must be replay or live')
}

const wallet = await serverWallet('SELLER_PRIVATE_KEY', 24, 10_000, true)
const { publicKey } = await wallet.getPublicKey({ identityKey: true })

let seller: ProtectionSeller
let lastTimestamp = 0

if (mode === 'live') {
  console.log('Initializing live BSV/USD market...')
  const history = await fetchBsvHistory()
  seller = new ProtectionSeller(wallet, history.map(point => point.price), history.length - 1, true)
  lastTimestamp = history[history.length - 1].updatedAt
  console.log(`Loaded ${history.length} real historical observations`)
  console.log(`Starting BSV/USD price: $${seller.price.toFixed(4)}`)
  console.log('Source: CoinGecko')
  console.log(liveTrading ? 'Live mode: protection sales ENABLED (real payments)' : 'Live mode: read-only, payments disabled (set LIVE_TRADING=1 to enable)')
} else {
  seller = new ProtectionSeller(wallet, loadPrices(process.argv[2]))
  console.log(`Replay interval: ${CONFIG.stepSeconds}s`)
}
console.log(`Collateral: ${await balance(wallet)} sats`)

// keep a copy of the ledger on disk (submission links, dashboard); it survives Ctrl+C
const ledgerFile = `hedge-ledger-${mode}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`
const saveLedger = (): void => {
  const buyers = [...seller.buyers].map(([id, b]) => ({ id, floor: b.floor, premiums: b.premiums, payouts: b.payouts }))
  writeFileSync(ledgerFile, JSON.stringify({ mode, step: seller.step, price: seller.price, ledger: seller.ledger, buyers }, null, 2))
}
console.log(`Ledger is saved after every step to ${ledgerFile}`)

const sellerApp = createSellerApp(seller)

// Payments travel in an HTTP header together with their unconfirmed ancestors (BEEF), which grows between blocks.
// Node's default 16 KB header limit would reject them (HTTP 431) AFTER the buyer paid, so allow up to 4 MB.
createServer({ maxHeaderSize: 4 * 1024 * 1024 }, (req, res) => {
  if (mode === 'live' && !liveTrading && req.url?.startsWith('/protection')) {
    res.writeHead(503, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Live market is read-only. Payments are disabled (LIVE_TRADING=1 enables them).' }))
    return
  }
  sellerApp(req, res)
}).listen(CONFIG.sellerPort, () => {
  console.log(`Seller on http://localhost:${CONFIG.sellerPort}`)
  console.log(`Identity: ${publicKey}`)
  console.log(`Mode: ${mode}`)
})

if (mode === 'live') {
  console.log(`Fetching live BSV prices every ${LIVE_INTERVAL_SECONDS} seconds`)
  let updating = false

  const updateLiveMarket = async (): Promise<void> => {
    if (updating) return
    updating = true
    try {
      const observation = await fetchLiveBsvPrice()
      if (observation.updatedAt <= lastTimestamp) {
        console.log('No new market observation')
        return
      }
      await seller.tickLive(observation.price)
      lastTimestamp = observation.updatedAt
      saveLedger()
      console.log(`LIVE step ${seller.step} BSV/USD $${seller.price.toFixed(4)} vol ${(seller.vol() * 100).toFixed(3)}%`)
    } catch (error) {
      console.error('[live market]', error instanceof Error ? error.message : error) // keep running on CoinGecko errors
    } finally {
      updating = false
    }
  }

  await updateLiveMarket()
  setInterval(() => { void updateLiveMarket() }, LIVE_INTERVAL_SECONDS * 1000)
} else {
  console.log('Waiting for first buyer to start replay...')
  const waitForBuyer = setInterval(() => {
    if (seller.buyers.size === 0) return
    clearInterval(waitForBuyer)
    console.log(`First buyer connected. Market starts at $${seller.price.toFixed(4)}`)

    const timer = setInterval(() => {
      void seller.tick().then(() => {
        saveLedger()
        console.log(`step ${seller.step} $${seller.price.toFixed(4)} vol ${(seller.vol() * 100).toFixed(3)}%`)
        if (seller.done) {
          clearInterval(timer)
          console.log('Market replay finished.')
          console.log(`Ledger: http://localhost:${CONFIG.sellerPort}/ledger  (also saved in ${ledgerFile})`)
        }
      }).catch(error => {
        clearInterval(timer)
        console.error('Replay failed:', error)
      })
    }, CONFIG.stepSeconds * 1000)
  }, 500)
}

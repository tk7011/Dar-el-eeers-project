
import { createServer } from 'node:http'
import { CONFIG } from './config'
import { loadPrices } from './market'
import { ProtectionSeller, createSellerApp } from './seller'
import { balance, serverWallet } from './wallets'
import {
  fetchLiveBsvPrice,
  fetchBsvHistory
} from './live-price'

const mode = process.env.PRICE_MODE ?? 'replay'
const LIVE_INTERVAL_SECONDS = 60

if (mode !== 'replay' && mode !== 'live') {
  throw new Error('PRICE_MODE must be replay or live')
}

const wallet = await serverWallet('SELLER_PRIVATE_KEY', 24, 10000)
const { publicKey } = await wallet.getPublicKey({
  identityKey: true
})

let seller: ProtectionSeller
let lastTimestamp = 0

if (mode === 'live') {
  console.log('Initializing live BSV/USD market...')

  const history = await fetchBsvHistory()

  seller = new ProtectionSeller(
    wallet,
    history.map(point => point.price),
    history.length - 1,
    true
  )

  lastTimestamp = history[history.length - 1].updatedAt

  console.log(`Loaded ${history.length} real historical observations`)
  console.log(`Starting BSV/USD price: $${seller.price.toFixed(4)}`)
  console.log('Source: CoinGecko')
  console.log('Live mode: read-only, payments disabled')
} else {
  seller = new ProtectionSeller(
    wallet,
    loadPrices(process.argv[2])
  )

  console.log(`Collateral: ${await balance(wallet)} sats`)
  console.log(`Replay interval: ${CONFIG.stepSeconds}s`)
}

const sellerApp = createSellerApp(seller)

createServer(
  { maxHeaderSize: 4 * 1024 * 1024 },
  (req, res) => {
    if (
      mode === 'live' &&
      req.url?.startsWith('/protection')
    ) {
      res.writeHead(503, {
        'Content-Type': 'application/json'
      })

      res.end(JSON.stringify({
        error: 'Live market is read-only. Payments are disabled.'
      }))
      return
    }

    sellerApp(req, res)
  }
).listen(CONFIG.sellerPort, () => {
  console.log(`Seller on http://localhost:${CONFIG.sellerPort}`)
  console.log(`Identity: ${publicKey}`)
  console.log(`Mode: ${mode}`)
})

if (mode === 'live') {
  console.log(
    `Fetching live BSV prices every ${LIVE_INTERVAL_SECONDS} seconds`
  )

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

      console.log(
        `LIVE step ${seller.step} ` +
        `BSV/USD $${seller.price.toFixed(4)} ` +
        `vol ${(seller.vol() * 100).toFixed(3)}%`
      )
    } catch (error) {
      console.error(
        '[live market]',
        error instanceof Error ? error.message : error
      )
    } finally {
      updating = false
    }
  }

  await updateLiveMarket()

  setInterval(() => {
    void updateLiveMarket()
  }, LIVE_INTERVAL_SECONDS * 1000)

} else {
  console.log('Waiting for first buyer to start replay...')

  const waitForBuyer = setInterval(() => {
    if (seller.buyers.size === 0) return

    clearInterval(waitForBuyer)

    console.log(
      `First buyer connected. Market starts at $${seller.price.toFixed(4)}`
    )

    const timer = setInterval(() => {
      void seller.tick().then(() => {
        console.log(
          `step ${seller.step} ` +
          `$${seller.price.toFixed(4)} ` +
          `vol ${(seller.vol() * 100).toFixed(3)}%`
        )

        if (seller.done) {
          clearInterval(timer)
          console.log('Market replay finished.')
          console.log(
            `Ledger: http://localhost:${CONFIG.sellerPort}/ledger`
          )
        }
      }).catch(error => {
        clearInterval(timer)
        console.error('Replay failed:', error)
      })
    }, CONFIG.stepSeconds * 1000)
  }, 500)
}

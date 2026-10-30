
import assert from 'node:assert/strict'
import { AuthFetch } from '@bsv/sdk'
import { loadPrices } from './market'
import { ProtectionSeller, createSellerApp } from './seller'
import { serverWallet } from './wallets'

const sw = await serverWallet('SELLER_PRIVATE_KEY')
const aw = await serverWallet('AGENT_PRIVATE_KEY')

const seller = new ProtectionSeller(sw, loadPrices())
const server = createSellerApp(seller).listen(18097)

try {
  const marketResponse = await fetch('http://localhost:18097/market')
  assert.equal(marketResponse.status, 200)

  const market = await marketResponse.json()
  assert.ok(Number.isFinite(market.price))
  assert.ok(market.price > 0)
  assert.ok(Number.isInteger(market.step))

  console.log('PASS: Market endpoint returns valid data')

  const quoteResponse = await new AuthFetch(aw).fetch(
    'http://localhost:18097/protection/quote?sats=200000'
  )

  assert.equal(quoteResponse.status, 200)

  const quote = await quoteResponse.json()
  assert.ok(Number.isInteger(quote.premium))
  assert.ok(quote.premium >= 0)
  assert.ok(Number.isInteger(quote.minutes))
  assert.ok(quote.minutes > 0)
  assert.ok(Number.isFinite(quote.floor))
  assert.ok(quote.floor > 0)

  console.log('PASS: Authenticated quote is valid')
  console.log('Premium:', quote.premium, 'sats')
  console.log('Duration:', quote.minutes, 'minutes')
  console.log('Floor:', quote.floor)
  console.log('All smoke tests passed!')
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
  })
}

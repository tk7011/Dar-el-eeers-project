/** Start the protection seller on mainnet:  npx tsx hedge/run-seller.ts [prices.csv]
 *  The market clock starts when the first buyer asks for a quote, so a demo always starts from the calm phase. */
import { createServer } from 'node:http'
import { CONFIG } from './config'
import { loadPrices } from './market'
import { ProtectionSeller, createSellerApp } from './seller'
import { balance, serverWallet } from './wallets'

const wallet = await serverWallet('SELLER_PRIVATE_KEY', 24, 10_000)
const { publicKey } = await wallet.getPublicKey({ identityKey: true })
const seller = new ProtectionSeller(wallet, loadPrices(process.argv[2]))
// Payments travel in an HTTP header together with their unconfirmed ancestors (BEEF), which grows between blocks.
// Node's default 16 KB header limit would reject them (HTTP 431) AFTER the buyer paid, so allow up to 4 MB.
createServer({ maxHeaderSize: 4 * 1024 * 1024 }, createSellerApp(seller)).listen(CONFIG.sellerPort, () => {
  console.log(`Seller on http://localhost:${CONFIG.sellerPort}   identity ${publicKey}`)
})
console.log(`Collateral: ${await balance(wallet)} sats. One market step every ${CONFIG.stepSeconds}s.`)
console.log('Waiting for the first buyer before starting the market clock…')

const waitForBuyer = setInterval(() => {
  if (seller.buyers.size === 0) return
  clearInterval(waitForBuyer)
  console.log(`First buyer connected. Market starts at $${seller.price.toFixed(4)}.`)
  const timer = setInterval(() => {
    void seller.tick().then(() => {
      console.log(`step ${seller.step}  $${seller.price.toFixed(4)}  vol ${(seller.vol() * 100).toFixed(3)}%`)
      if (seller.done) { clearInterval(timer); console.log('Market replay finished. Ledger: http://localhost:8090/ledger') }
    })
  }, CONFIG.stepSeconds * 1000)
}, 500)

/** Start the protection seller on mainnet:  npx tsx hedge/run-seller.ts [prices.csv] */
import { CONFIG } from './config'
import { loadPrices } from './market'
import { ProtectionSeller, createSellerApp } from './seller'
import { balance, serverWallet } from './wallets'

const wallet = await serverWallet('SELLER_PRIVATE_KEY', 24, 10_000)
const { publicKey } = await wallet.getPublicKey({ identityKey: true })
const seller = new ProtectionSeller(wallet, loadPrices(process.argv[2]))
createSellerApp(seller).listen(CONFIG.sellerPort, () => {
  console.log(`Seller on http://localhost:${CONFIG.sellerPort}   identity ${publicKey}`)
})
console.log(`Collateral: ${await balance(wallet)} sats. One market step every ${CONFIG.stepSeconds}s.`)
const timer = setInterval(() => {
  void seller.tick().then(() => {
    console.log(`step ${seller.step}  $${seller.price.toFixed(4)}  vol ${(seller.vol() * 100).toFixed(3)}%`)
    if (seller.done) { clearInterval(timer); console.log('Market replay finished. Ledger: GET /ledger') }
  })
}, CONFIG.stepSeconds * 1000)

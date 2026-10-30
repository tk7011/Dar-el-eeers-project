/** Offline check (no payments): seller + agent server wallets start and authenticate.  npx tsx hedge/smoke.ts */
import { AuthFetch } from '@bsv/sdk'
import { loadPrices } from './market'
import { ProtectionSeller, createSellerApp } from './seller'
import { serverWallet } from './wallets'
const sw = await serverWallet('SELLER_PRIVATE_KEY')
const aw = await serverWallet('AGENT_PRIVATE_KEY')
const seller = new ProtectionSeller(sw, loadPrices())
const server = createSellerApp(seller).listen(18097)
const m = await (await fetch('http://localhost:18097/market')).json()
console.log('market ok, step', m.step, 'price', m.price)
const q = await (await new AuthFetch(aw).fetch('http://localhost:18097/protection/quote?sats=200000')).json()
console.log('authenticated quote ok:', q.premium, 'sats for', q.minutes, 'min, floor', q.floor.toFixed(4))
server.close(); process.exit(0)

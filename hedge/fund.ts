/**
 * Fund a server wallet from your BSV Desktop wallet (BRC-29, verified + internalized at once).
 *   npx tsx hedge/fund.ts seller 30000    → seller collateral
 *   npx tsx hedge/fund.ts agent 20000     → the agent's own budget
 * BSV Desktop will ask you to approve the payment.
 */
import { acceptBrc29Payment, createBrc29Payment } from '../client/payments'
import { balance, desktopWallet, serverWallet } from './wallets'

const [who, amount] = [process.argv[2], Number(process.argv[3])]
if ((who !== 'seller' && who !== 'agent') || !Number.isInteger(amount) || amount <= 0) {
  console.log('usage: npx tsx hedge/fund.ts <seller|agent> <satoshis>'); process.exit(1)
}
const target = await serverWallet(who === 'seller' ? 'SELLER_PRIVATE_KEY' : 'AGENT_PRIVATE_KEY')
const { publicKey } = await target.getPublicKey({ identityKey: true })
const user = await desktopWallet()
console.log(`Paying ${amount} sats from BSV Desktop to the ${who} (${publicKey.slice(0, 16)}…). Approve in BSV Desktop.`)
const payment = await createBrc29Payment(user, publicKey, amount, `Fund hedge ${who}`)
await acceptBrc29Payment(target, payment, undefined, `Funding from owner`)
console.log(`Done. ${who} balance: ${await balance(target)} sats   https://whatsonchain.com/tx/${payment.txid}`)
process.exit(0)

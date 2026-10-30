/**
 * Start the buyer agent:
 *   npx tsx hedge/run-agent.ts            agent pays from its own server wallet (fund it with hedge/fund.ts)
 *   npx tsx hedge/run-agent.ts desktop    agent pays from YOUR BSV Desktop wallet (you approve spending there)
 * Every decision is appended to hedge-events.jsonl.
 */
import { CONFIG } from './config'
import { runAgent } from './agent'
import { balance, desktopWallet, serverWallet } from './wallets'

const useDesktop = process.argv[2] === 'desktop'
const wallet = useDesktop ? await desktopWallet() : await serverWallet('AGENT_PRIVATE_KEY', 24, 3_000)
console.log(`Agent wallet: ${useDesktop ? 'BSV Desktop' : 'server wallet'}, balance ${await balance(wallet)} sats`)
console.log(`Protecting ${CONFIG.protectSats} sats, premium budget ${CONFIG.budgetSats}, max ${CONFIG.maxPurchaseSats}/purchase, LLM: ${process.env.GROQ_API_KEY !== undefined && process.env.NO_LLM !== '1' ? 'on' : 'off (rules)'}\n`)
const r = await runAgent(wallet, { log: 'hedge-events.jsonl' })
const usd = (sats: number, price: number): number => sats * price / 1e8
console.log('\n=== Summary ===')
console.log(`BSV price: $${r.startPrice} → $${r.endPrice}`)
console.log(`Premiums paid ${r.premiums} sats in ${r.purchases} purchases · payouts received ${r.payouts} sats`)
console.log(`Treasury value unprotected: $${usd(CONFIG.protectSats, r.startPrice).toFixed(4)} → $${usd(CONFIG.protectSats, r.endPrice).toFixed(4)}`)
console.log(`Treasury value protected:   $${usd(CONFIG.protectSats, r.startPrice).toFixed(4)} → $${usd(CONFIG.protectSats + r.payouts - r.premiums, r.endPrice).toFixed(4)}`)
process.exit(0)

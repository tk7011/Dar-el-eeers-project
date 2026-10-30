/** Wallets: server wallets (seller, agent) via wallet-toolbox (guide §14), and the user's BSV Desktop. */
import { PrivateKey, WalletClient, type WalletInterface } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'

try { process.loadEnvFile() } catch { /* no .env yet */ }

/** A server wallet whose root key comes from an environment variable (never logged, never committed). */
export async function serverWallet (keyEnv: 'SELLER_PRIVATE_KEY' | 'AGENT_PRIVATE_KEY', changeCount = 24, changeSats = 5_000, runMonitor = false): Promise<WalletInterface & { setWalletChangeParams: (c: number, s: number) => Promise<void> }> {
  const hex = process.env[keyEnv]
  if (hex === undefined || hex === '') throw new Error(`${keyEnv} missing: run "npx tsx hedge/keys.ts" first`)
  const rootKey = PrivateKey.fromHex(hex)
  const identityKey = rootKey.toPublicKey().toString()
  const env = { chain: 'main' as const, identityKey, identityKey2: identityKey, taalApiKey: '', devKeys: {}, mySQLConnection: '{}' }
  const name = keyEnv === 'SELLER_PRIVATE_KEY' ? 'seller' : 'agent'
  const setup = await Setup.createWalletSQLite({ env, rootKeyHex: rootKey.toHex(), filePath: `./hedge-${name}.sqlite`, databaseName: `hedge_${name}` })
  // many independent change coins: rapid payments without long unconfirmed chains (guide §11)
  await setup.wallet.setWalletChangeParams(changeCount, changeSats)
  if (runMonitor) await startMonitor(setup.monitor, name)
  return setup.wallet as any
}

/**
 * The monitor fetches merkle proofs once transactions are mined and retries broadcasts (guide §14.2).
 * Without it the wallet believes every past payment is still unconfirmed, the chain of unconfirmed
 * ancestors grows with every payment, and payments fail with "Maximum BEEF depth exceeded. Limit is 12".
 */
async function startMonitor (monitor: { addDefaultTasks: () => void, runOnce: () => Promise<void>, startTasks: () => Promise<void> }, name: string): Promise<void> {
  monitor.addDefaultTasks()
  // catch up on proofs for transactions mined since the last run (at most ~45 s, then continue in the background)
  console.log(`[${name}] monitor: fetching proofs for mined transactions…`)
  const catchUp = monitor.runOnce().catch(e => { console.error(`[${name}] monitor:`, (e as Error).message) })
  await Promise.race([catchUp, new Promise(resolve => setTimeout(resolve, 45_000))])
  void monitor.startTasks().catch(e => { console.error(`[${name}] monitor stopped:`, (e as Error).message) })
  console.log(`[${name}] monitor running`)
}

/** The user's own wallet (BSV Desktop must be open and unlocked). Keys never leave it. */
export async function desktopWallet (originator = 'agent-hedge.local'): Promise<WalletInterface> {
  const wallet = new WalletClient('auto', originator)
  await wallet.waitForAuthentication({})
  return wallet
}

export async function balance (wallet: WalletInterface): Promise<number> {
  let total = 0
  for (let offset = 0; ; offset += 100) {
    const { outputs, totalOutputs } = await wallet.listOutputs({ basket: 'default', limit: 100, offset })
    for (const o of outputs) if (o.spendable) total += o.satoshis
    if (outputs.length === 0 || offset + outputs.length >= totalOutputs) break
  }
  return total
}

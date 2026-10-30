/** Wallets: server wallets (seller, agent) via wallet-toolbox (guide §14), and the user's BSV Desktop. */
import { PrivateKey, WalletClient, type WalletInterface } from '@bsv/sdk'
import { Setup } from '@bsv/wallet-toolbox'

try { process.loadEnvFile() } catch { /* no .env yet */ }

/** A server wallet whose root key comes from an environment variable (never logged, never committed). */
export async function serverWallet (keyEnv: 'SELLER_PRIVATE_KEY' | 'AGENT_PRIVATE_KEY', changeCount = 24, changeSats = 5_000): Promise<WalletInterface & { setWalletChangeParams: (c: number, s: number) => Promise<void> }> {
  const hex = process.env[keyEnv]
  if (hex === undefined || hex === '') throw new Error(`${keyEnv} missing: run "npx tsx hedge/keys.ts" first`)
  const rootKey = PrivateKey.fromHex(hex)
  const identityKey = rootKey.toPublicKey().toString()
  const env = { chain: 'main' as const, identityKey, identityKey2: identityKey, taalApiKey: '', devKeys: {}, mySQLConnection: '{}' }
  const name = keyEnv === 'SELLER_PRIVATE_KEY' ? 'seller' : 'agent'
  const setup = await Setup.createWalletSQLite({ env, rootKeyHex: rootKey.toHex(), filePath: `./hedge-${name}.sqlite`, databaseName: `hedge_${name}` })
  // many independent change coins: rapid payments without long unconfirmed chains (guide §11)
  await setup.wallet.setWalletChangeParams(changeCount, changeSats)
  return setup.wallet as any
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

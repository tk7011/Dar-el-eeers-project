/** Create the seller's and the agent's server-wallet keys in .env (once). Prints their PUBLIC identity keys only. */
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { PrivateKey } from '@bsv/sdk'

const text = existsSync('.env') ? readFileSync('.env', 'utf8') : ''
for (const name of ['SELLER_PRIVATE_KEY', 'AGENT_PRIVATE_KEY']) {
  const match = text.match(new RegExp(`^${name}=([0-9a-fA-F]{64})`, 'm'))
  let key = match?.[1]
  if (key === undefined) {
    key = PrivateKey.fromRandom().toHex()
    appendFileSync('.env', `${text === '' || text.endsWith('\n') ? '' : '\n'}${name}=${key}\n`)
  }
  console.log(`${name.replace('_PRIVATE_KEY', '').padEnd(6)} identity key: ${PrivateKey.fromHex(key).toPublicKey().toString()}`)
}
console.log('Keys are in .env. Keep that file secret and never commit it.')

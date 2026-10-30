# BSV-21 Token Kit

A plug-and-play BSV-21 token overlay, a client library for any BRC-100 wallet (BSV Desktop), 1Sat Ordinals NFTs, instant BRC-29 payments, an authenticated airdrop, pay-per-request APIs (HTTP 402: BRC-105 and BRC-121), and a minimal web UI.

The **overlay is the source of truth**: it only admits token UTXOs that descend, input by input, from the genuine deploy. The wallet's **`bsv21` basket is your local copy**: `sync()` brings in what the overlay says you own, and `send()` / `merge()` spend from it.

The full walkthrough is in `BSV_STACK_COMPLETE_GUIDE.md` (§13–§20), which embeds this kit's source in Appendix A.

## Run

```bash
npm install
npm run overlay   # http://localhost:8080 — SQLite in ./data, no MongoDB, no Docker; SPV headers from Arcade
npm run web       # http://localhost:5173 — open BSV Desktop (mainnet) and click "Connect wallet"
npm test          # 38 tests: rules + end-to-end on wallet-toolbox's mock chain
```

Overlay environment variables:
- `PORT`: HTTP port. Default `8080`.
- `OVERLAY_DB`: SQLite file. Default `./data/overlay.db`.
- `NETWORK`: `main` or `test`. Default `main`.
- `CHAINTRACKS_URL`: SPV block headers. Default Arcade, `https://arcade-v2-us-1.bsvblockchain.tech` (go-chaintracks at `/chaintracks/v2`).
- `CHAIN_TRACKER=woc`: use WhatsOnChain instead. `WOC_API_KEY` is optional; without a key the overlay retries with backoff on `429`.
- `TOKEN_WHITELIST`: comma-separated token ids. Empty means every token is indexed.
- `OVERLAY_PRIVATE_KEY`: the overlay's identity key. Defaults to a key generated into `./data/overlay.key`.

## Layout

| Part | Files | What it does |
|---|---|---|
| Inscriptions | `core/inscription.ts` | Canonical 1Sat inscriptions (`OP_1` content-type tag, any size) and BSV-21 on top: string JSON values, `txid_vout` ids |
| Rules | `core/rules.ts` | Port of `1sat-stack/pkg/bsv21/topic_validated.go`. A deploy is always admitted, because its id is its own outpoint. A transfer is admitted only if inputs **already admitted** cover its outputs. An unknown token input refuses the transaction |
| Keys | `core/addresses.ts` | BRC-42 with `counterparty: 'anyone'`. Tokens use protocol `[1,'bsv21 token']` with numbered keyIDs; NFTs use `[1,'one sat ordinals']` with a random keyID |
| Overlay | `overlay/` | `@bsv/overlay-express` on SQLite, topic `tm_tokenkit`, lookup `ls_tokenkit` |
| Tokens | `client/token.ts` | `deploy`, `sync` (retry, heal from chain, receive, relinquish), `balances`, `utxos`, `send` (largest-first coin selection with change), `merge` |
| NFTs | `client/ordinals.ts` | `mint`, `list`, `transfer` (ordinal at input 0 → output 0) and `receive` |
| Payments | `client/payments.ts` | BRC-29 `createBrc29Payment` and `acceptBrc29Payment` (SPV check, then internalize) |
| Signing | `client/signer.ts` | BIP-143 sighash over the full locking script, signed by the wallet's `createSignature`. The key never leaves the wallet |
| Arcade | `client/arcadeChainTracker.ts`, `client/overlayApi.ts` (`beefFromArcade`) | SDK ChainTracker on Arcade; rebuilding a BEEF from Arcade's `GET /tx/:txid` |
| Airdrop | `examples/airdropServer.ts` | Express + BRC-103/104 mutual auth. The server sets the amount; one claim per identity |
| Paid APIs | `examples/payPerRequest.ts` | HTTP 402 with the official middleware. BRC-105: `AuthFetch` pays automatically. BRC-121: `@bsv/402-pay`. Also `withHostOriginator()` for the 402-pay originator gotcha |
| UI | `web/` | Connect, create a token, balances (overlay vs basket), UTXOs, send, merge, sync, look up any identity key |

## What `npm test` proves

All tests use real `wallet-toolbox` wallets — the same wallet engine BSV Desktop runs — on its mock chain, with the overlay over HTTP and SPV.

1. **Tokens:**
   - deploy, with overlay and basket agreeing;
   - send to another identity key; the recipient sees it via the overlay **without being notified**;
   - merge, multi-input coin selection with change, supply conservation;
   - forgeries refused: from plain sats, and a fake inserted into the basket;
   - spent outputs move to history;
   - **recovery** of a wallet with no local data.
2. **Instant payments:** Alice pays Bob, and Bob **spends it before any block is mined**. Payments that are not ours, or worth less than claimed, are refused.
3. **NFTs:** mint at output 0; transfer with the ordinal at input 0 → output 0; the wrong recipient is refused; transfer back with the origin preserved.
4. **Airdrop:** an unauthenticated request is refused, the server-chosen amount is paid once, and a second claim gets 409.
5. **Paid APIs:**
   - **BRC-105:** a 402 is paid automatically and the merchant is credited exactly; a replayed payment gets 409.
   - **BRC-121:** a 402 is paid automatically; replayed headers get a fresh 402.

## Known limits

- **Privacy:** token receive addresses are deterministic and public, so anyone who knows an identity key can see its holdings.
- **Submission order:** the overlay never fetches missing parents. Token transactions must reach it in order; the client keeps a persistent outbox with retries, and `sync()` re-submits from chain anything the overlay never saw.
- **Spends outside the kit:** if a token UTXO is spent and that transaction is never submitted to the overlay, the overlay still shows it as unspent.
- **Not included:** STAS (planned) and hosted production deployment.
- **Tests and the SDK build:** tests force `@bsv/sdk` to its CJS build (see `vitest.config.ts`). The mock-chain harness also patches two `MockServices` behaviours of wallet-toolbox 2.14.9; see `test/helpers/mockchain.ts`.

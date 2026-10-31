# Hedgy: per-minute crash protection for AI agents on BSV

**TUM Blockchain & AI Hackathon 2026 · BSV Blockchain track**

AI agents pay for services in BSV, but their costs are in dollars. When BSV falls, their budget shrinks
and tasks fail halfway. **Hedgy lets an agent keep its BSV and buy downside protection one minute at a
time:** a seller quotes a tiny premium from live volatility, the agent decides whether it is worth it and pays
over HTTP 402, and if BSV ends the minute below a floor, the seller pays the lost dollar value back in BSV.
Short-term downside protection without converting the agent's BSV into a stablecoin.

## Why BSV
Premiums are a few sats, paid every minute. On chains with cent-level fees this business model cannot exist;
on BSV it costs fractions of a cent. Every premium and payout is a real transaction, and every payout carries
an OP_RETURN memo, so the whole hedge history is auditable on-chain.

## What it brings to BSV
- **A reason for agents to hold BSV:** protection can reduce the impact of price drops on their budget.
- **Protection supply:** sellers hold BSV in their wallets to fund payouts and earn premiums while accepting loss risk.
- **Volume:** each protected agent makes a micropayment every minute.

## Target users
- **AI agents and their owners** who pay for APIs, data or compute in BSV.
- **BSV holders** who want yield by selling protection.

## How it works
| | |
|---|---|
| **Quote** | Seller prices one minute of protection: a 1-minute put (Black-Scholes) on the floor + 25% margin, using the higher of short- and long-term volatility |
| **Decide** | The agent computes its own fair value; an LLM weighs cost vs risk and explains its choice; hard limits in code (budget, max per purchase, seller allowlist, one purchase per minute, a SpendGuard wallet wrapper) cannot be overruled |
| **Pay** | `GET /protection/buy` → **HTTP 402** (BRC-105) → `AuthFetch` pays automatically with a BRC-29 payment |
| **Settle** | Each covered minute pays new losses below the floor, BRC-29 + OP_RETURN memo; the agent verifies (SPV) and internalizes it, spendable at once |
| **Fund** | The dashboard connects **BSV Desktop**; the user funds their own agent directly (keys never leave the wallet) |

**Wallet architecture:** BSV Desktop funds separate agent and seller wallets. Their private keys are stored locally in .env. Premiums and payouts move between those wallets. Seller collateral is not locked by an on-chain contract; payouts depend on the seller's software and available funds.

Full technical guide: [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md)

## Run it
Requirements: Node.js 22+, BSV Desktop (mainnet, unlocked), a free Groq API key (optional, for LLM decisions).

```bash
npm install --ignore-scripts --legacy-peer-deps
cp .env.example .env                 # first setup only; never overwrite an existing .env
npx tsx hedge/keys.ts                    # creates seller + agent keys in .env (keep it secret)
npx tsx hedge/fund.ts seller 300000      # BSV Desktop funds the seller's collateral
# Optional: edit GROQ_API_KEY in .env            # optional

npx tsx hedge/run-seller.ts              # terminal 1 (replay of a BSV crash; PRICE_MODE=live for CoinGecko)
npx tsx hedge/run-agent.ts --wait        # terminal 2
npx vite dashboard                       # terminal 3 → http://localhost:5174
```
On the dashboard: **Connect BSV Desktop → Fund agent → Start agent**.

Offline rehearsal on the BSV mock chain (no coins): `npx vitest run test/hedge.e2e.test.ts`

## Example transactions (mainnet)
- Seller funding from BSV Desktop: https://whatsonchain.com/tx/fa6c542f8e40bd82e1ac0f04ae02c51acf1ffe4bdcde4f3eb2ced9d3a0b8a206
- Agent funding from BSV Desktop: https://whatsonchain.com/tx/eee8b3d9568f924d63ef02dc4e533c2940ae2998cefdf94e51fcc4532769e886
- Premium paid by the agent: https://whatsonchain.com/tx/7898aee68826989d95e402546089ea4dc9d3b0bcfa3724c0257dba5274ed7aa3
- Payout from the seller: https://whatsonchain.com/tx/b5017074b51d323e00a8e6e3d38ffffdc1d66049829679ca328ee7b2189e34af

## Limits and next steps
- Prototype only: this demonstrates the payment and protection workflow, not guaranteed budget stability or seller profitability.
- Demo prices replay a scripted crash, accelerated to 15 seconds per market minute. Live mode is also available.
- Each buyer's floor is fixed on its first quote and remains until seller state is reset. Explicit session expiry and renewal are not implemented.
- Coverage, quotes and pending payouts are held in memory. Exported ledgers do not restore coverage after restart.
- Seller collateral is not contract-locked, and admission checks against reserved obligations are not implemented.
- Failed payout attempts are logged but are not automatically retried.
- LLM decisions require a valid Groq key. Missing credentials or request failures cause a fallback to rules; code enforces spending limits.
- A local npm audit reported a high-severity body-parser advisory; dependency remediation remains open.

## Built on
BSV Association's TypeScript stack (`@bsv/sdk`, `@bsv/wallet-toolbox`, auth/payment middleware) and the TBC26
BSV developer pack starter kit (`client/`, `examples/`, `overlay/`, `web/`), see [`STARTER-KIT.md`](STARTER-KIT.md).

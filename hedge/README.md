# Hedgy: per-minute downside protection for agents on BSV

AI agents pay in BSV, but their costs are in dollars. When BSV falls, their budget shrinks.
Hedgy lets an agent **keep its BSV and buy protection one minute at a time**: a seller quotes
a premium from live volatility, the agent decides whether it's worth it, pays over HTTP 402, and
if the price ends the minute below the floor, the seller pays the lost dollar value back in BSV.

## How it works
| Step | What happens | BSV stack |
|---|---|---|
| Quote | `GET /protection/quote?sats=` → premium = 1-min put value × (1 + margin) | BRC-103/104 mutual auth |
| Decide | Agent computes its own fair value; LLM (Groq) or rules decide buy/skip and cover | – |
| Pay | `GET /protection/buy?quoteId=` → **402** → `AuthFetch` pays → 200 | BRC-105 pay-per-request, BRC-29 |
| Settle | Each covered minute pays new losses below the floor, with an OP_RETURN memo | BRC-29 + OP_RETURN |
| Collect | Agent verifies (SPV) and internalizes payouts, spendable at once | `internalizeAction` |

**Seller defences against adverse selection:** price uses the higher of short/long-term volatility,
new buyers prepay `MIN_MINUTES`, coverage cap per buyer, minimum premium above fees.

**Agent safety (the LLM proposes, code decides):** total budget, max per purchase, seller allowlist,
one purchase per minute, and a `SpendGuard` wallet wrapper that refuses any payment larger than the
amount approved for that purchase, even if the server's 402 asks for more.

**Wallet architecture:** Agent and seller keys are stored locally in .env. Payments move directly between their wallets. Seller collateral is not contract-locked, and payouts depend on available funds and successful transaction processing. See the root README for prototype limitations.

## Run (mainnet, inside the starter kit folder)
```powershell
npx tsx hedge/keys.ts                    # creates SELLER/AGENT keys in .env (once)
npx tsx hedge/smoke.ts                   # offline check: wallets start, auth works
npx tsx hedge/fund.ts seller 300000       # BSV Desktop funds the seller's collateral
npx tsx hedge/fund.ts agent 20000        # BSV Desktop funds the agent's budget
npx tsx hedge/run-seller.ts              # terminal 1
npx tsx hedge/run-agent.ts               # terminal 2  (or: run-agent.ts desktop → pays from BSV Desktop)
npx vitest run test/hedge.e2e.test.ts    # full offline rehearsal on the mock chain
```
Settings (budget, protected size, step length…) are in `hedge/config.ts` and can be overridden in `.env`.
Set `GROQ_API_KEY` for LLM decisions, or `NO_LLM=1` for rules only.
Ledger with every txid: `http://localhost:8090/ledger`. Agent decisions: `hedge-events.jsonl`.

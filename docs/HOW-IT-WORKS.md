# Hedgy: how it works (team guide)

This is the shared reference for both of us. If the code changes, update this file in the same commit.
Read it top to bottom once; after that, use the section headings to look things up.

---

## 1. The idea in one paragraph

AI agents pay for things (API calls, data, compute) in BSV, but their costs are priced in dollars.
If BSV falls 20%, the agent's budget buys 20% less, and its tasks can fail halfway. The usual fix is a
stablecoin (swap, bridge, leave BSV). **Our fix:** the agent keeps its BSV and buys **crash protection one
minute at a time**. A seller quotes a tiny premium each minute; if BSV falls below a floor during a covered
minute, the seller pays the lost dollar value back in BSV. Every premium and every payout is a real BSV
micropayment. Per-minute pricing only works because BSV fees are fractions of a cent.

**Who gains what**
- **Agent (buyer):** stable dollar value for its budget, without a stablecoin, and it can stop any minute.
- **Seller:** yield on idle BSV (premiums), repriced every minute, never locked into a bad quote.
- **BSV:** transaction volume (a payment every minute per agent), liquidity (seller collateral), and a reason
  for agents to hold BSV.

---

## 2. The contract (the most important part to understand)

**Floor.** When the agent first connects, the seller fixes a floor at **97% of the current price**
(`FLOOR_PCT = 0.97`). It never moves during the session.

Example with round numbers: the agent's BSV is worth $100 → floor = $97.

| BSV value falls to | Agent's own loss | Seller pays | Agent keeps |
|---|---|---|---|
| $99 | $1 | $0 | $99 |
| $97 | $3 | $0 | $97 |
| $90 | $3 | $7 | $97 |

- The first 3% is the agent's own loss, like an insurance **deductible**. That keeps protection cheap in
  calm markets.
- **Why the floor does not follow the price:** a floor that is always 3% below the current price would never be
  crossed by a slow slide (−1% per minute for 10 minutes = −10% and no payout ever). A fixed floor protects
  against the total fall.
- **Possible upgrade:** a floor that only moves *up* (locks in gains). Not built.

**One minute = one contract.** The agent buys protection for the next minute only, and decides again
every minute. **Only covered minutes are protected:** if the agent skips a minute and BSV falls, that loss
is the agent's.

**Payout rule.** For each covered minute:
`payout = max(0, min(floor, price at start) − price at end) × protected amount`, converted to sats at the new price.
`min(floor, price at start)` means **only new losses** are paid. A loss already paid is never paid twice.

---

## 3. One minute, step by step

```
            Agent (buyer)                                Seller (port 8090)
                 │  GET /market  (price, volatility)   ──►│
                 │  GET /protection/quote?sats=…  (auth)──►│ premium = fair 1-min put × 1.25
                 │◄── quote: premium, minutes, floor       │
 math + LLM ─────┤  decide: buy or skip, how much cover    │
 safety layer ───┤  budget / max / allowlist / once-a-min  │
                 │  GET /protection/buy?quoteId=…         ──►│ 402 Payment Required
                 │  AuthFetch pays automatically (BRC-29) ──►│ verifies + internalizes → coverage recorded
                 │                                         │
                 │                      end of the minute: │ price < floor? → payout with OP_RETURN memo
                 │  GET /protection/payouts (auth)        ──►│
                 │◄── payout (BRC-29)                      │
  verify (SPV) + internalize → spendable at once           │
```

All of this is real BSV mainnet; every arrow with sats is a transaction on WhatsOnChain.

---

## 4. Pricing (`hedge/market.ts`)

- **Volatility:** standard deviation of the last minute-to-minute log returns.
- **Fair premium for one minute** = the expected payout = a Black-Scholes **put option** with a 1-minute
  expiry, strike = `min(floor, price)`.
  - Price far above the floor → almost no chance of a payout → fair value ≈ 0 → the seller charges the
    minimum (10 sats).
  - Price at or below the floor → payout likely → fair value high (hundreds of sats).
- **Seller's price** = fair value × (1 + 25% margin), at least `MIN_PREMIUM_SATS`.
- **The agent computes its own fair value** (with its own volatility window) to judge whether the seller's
  quote is reasonable.
- Known simplification: Black-Scholes underestimates crash risk (fat tails). Acceptable for one minute;
  the margin and per-minute repricing cover it.

---

## 5. Protecting the seller

| Risk | Defence in the code |
|---|---|
| **Adverse selection:** the buyer only buys when it "smells smoke" | Volatility = the **higher** of short- and long-term, so a spike is priced in at once. New buyers must **prepay 3 minutes** (`MIN_MINUTES`). |
| One buyer drains the seller | Coverage cap per buyer (`MAX_PROTECTED_SATS`) |
| Premium below network fees | Minimum premium 10 sats |
| A crash that lasts and lasts | The seller reprices every minute and could stop quoting. **Not built yet:** automatic stop when collateral is low, and a loss limit per buyer. |

The seller still loses money if BSV keeps falling hard every minute. That is the insurer's risk in exchange
for the premiums; real sellers would also hedge elsewhere (e.g. short futures).

---

## 6. The AI agent (`hedge/agent.ts`)

Every minute:
1. Reads the market and asks the seller for a quote.
2. **Math (code):** its own fair value, distance to floor, volatility, suggested cover, premium as % of treasury.
3. **Judgment (LLM, Groq `openai/gpt-oss-120b`):** gets every amount labelled in **sats and dollars**,
   answers `{action: buy|skip, cover, reason}`. Rules it is told:
   - buy while premium ≤ risk aversion × fair value;
   - keep protection on if it is negligible (< 0.05% of the treasury per minute), because dropping it means
     prepaying 3 minutes to come back;
   - don't drop protection exactly when a crash becomes likely.
4. **If the LLM fails** (no key, bad answer), a rule-based policy decides instead, so the demo never stalls.
5. **Safety layer (code, cannot be overruled):**
   - total budget (`BUDGET_SATS`)
   - max per purchase (`MAX_PURCHASE_SATS`)
   - seller allowlist (`SELLER_IDENTITY_KEY`, optional)
   - at most one purchase per minute (idempotency)
   - **SpendGuard:** wraps the wallet so no payment can exceed the amount approved for that purchase, even if
     the seller's 402 asks for more. AuthFetch would otherwise pay whatever is asked.
6. Pays, collects payouts, verifies them (SPV), logs everything (`hedge-events.jsonl`, dashboard).

**"The LLM proposes, the code decides."**

**Decision states on the dashboard**

| State | Meaning |
|---|---|
| BOUGHT | LLM said buy, rules allowed it, payment went through |
| SKIPPED | LLM said skip, nothing paid |
| BLOCKED | LLM said buy, a **safety rule** refused (on purpose), e.g. budget exhausted |
| FAILED | LLM said buy, rules allowed it, the **payment broke** for a technical reason; no sats spent |

---

## 7. BSV pieces we use (and why)

| Piece | What it does for us |
|---|---|
| `@bsv/sdk` | Transactions, keys, `AuthFetch`, `WalletClient` |
| `@bsv/wallet-toolbox` | The seller's and agent's own wallets (SQLite), same engine as BSV Desktop |
| **BRC-103/104** (`auth-express-middleware`) | Mutual authentication: the seller knows *which* agent is calling |
| **BRC-105** (`payment-express-middleware` + `AuthFetch`) | HTTP 402 pay-per-request: "this minute costs X sats" → the agent pays automatically |
| **BRC-29** | Payments to a derived key of the recipient (no address reuse); used for premiums, payouts, funding |
| **OP_RETURN memo** | Each payout carries `agent-hedge step N payout X strike Y close Z` on-chain (traceability) |
| **SPV / AtomicBEEF** | The receiver verifies a payment without waiting for a block (0-conf) |
| **Monitor** | Fetches block proofs for our transactions. Without it, payments eventually fail with "BEEF depth exceeded". |
| **BSV Desktop** | The user's wallet. The dashboard's "Fund agent" button pays the agent from it; keys never leave it. |

x402 is the general idea; BRC-105 is BSV's official version of it, which is what the track asks for.

---

## 8. Who holds what (non-custodial design)

| Wallet | Owner | Holds |
|---|---|---|
| BSV Desktop | the user | the user's own BSV |
| Agent wallet (`AGENT_PRIVATE_KEY`) | the user (the key is in their `.env`) | the agent's spending budget |
| Seller wallet (`SELLER_PRIVATE_KEY`) | the seller | the seller's own collateral and premiums |

- Premiums go **directly** from agent to seller; payouts **directly** from seller to agent.
- **No server ever holds anyone else's money.**
- In the demo we run both sides ourselves; in reality the seller is a different party.
- **Honest weak spot:** the agent trusts the seller to pay out. Production answer: lock the seller's
  collateral in a BSV script that pays automatically.

---

## 9. Files

| File | Role |
|---|---|
| `hedge/config.ts` | All settings (section 10) |
| `hedge/market.ts` | Price path (replay), volatility, 1-minute put, payout rule |
| `hedge/seller.ts` | Seller logic + HTTP API (`/market`, `/ledger`, `/protection/quote`, `/protection/buy`, `/protection/payouts`) |
| `hedge/run-seller.ts` | Starts the seller: replay (default) or live prices; saves `hedge-ledger-*.json` every step |
| `hedge/live-price.ts` | CoinGecko BSV/USD: current price and 21 past points (written by Yassine) |
| `hedge/agent.ts` | The buyer agent: decision (LLM + rules), safety layer, SpendGuard, payment loop |
| `hedge/run-agent.ts` | Starts the agent + its small API for the dashboard (port 8091: `/info`, `/events`, `/fund`, `/start`) |
| `hedge/wallets.ts` | Creates the server wallets (and starts their monitor), connects to BSV Desktop, balance |
| `hedge/keys.ts` | Creates the seller and agent keys in `.env` once |
| `hedge/fund.ts` | Command-line funding from BSV Desktop |
| `hedge/smoke.ts` | Quick check without payments (validation by Yassine) |
| `dashboard/` | Web page (port 5174): fund from BSV Desktop, start, charts, decisions, ledger |
| `test/hedge.e2e.test.ts` | Full offline rehearsal on the BSV mock chain |
| `client/payments.ts`, `examples/`, `core/`, `overlay/`, `web/` | From the BSV starter kit (we reuse `client/payments.ts`) |

---

## 10. Settings (`.env` overrides `hedge/config.ts`)

| Setting | Default | Meaning |
|---|---|---|
| `STEP_SECONDS` | 15 | Real seconds per market "minute" in replay |
| `FLOOR_PCT` | 0.97 | Floor = 97% of the starting price (3% deductible) |
| `SELLER_MARGIN` | 0.25 | Seller charges fair value + 25% |
| `MIN_PREMIUM_SATS` | 10 | Cheapest minute |
| `MIN_MINUTES` | 3 | New buyers prepay 3 minutes |
| `MAX_PROTECTED_SATS` | 1,000,000 | Coverage cap per buyer |
| `PROTECT_SATS` | 200,000 | Size of the agent's treasury to protect (≈ $0.06) |
| `BUDGET_SATS` | 10,000 | Max premiums per run (use 20,000 for a full crash) |
| `MAX_PURCHASE_SATS` | 5,000 | Max for a single purchase |
| `RISK_AVERSION` | 2.0 | Agent accepts up to 2× its own fair value |
| `TARGET_VOL_PCT` | 0 (off) | Only cover risk above this downside volatility |
| `PRICE_MODE` | replay | `live` = CoinGecko prices, one step per minute |
| `LIVE_TRADING` | off | `1` = allow real protection sales in live mode |
| `GROQ_API_KEY` | – | LLM decisions; without it, rules decide |

---

## 11. How it changed from the first plan, and why

| First plan | Now | Why |
|---|---|---|
| Hedge any asset (BTC) | Protect the **agent's own BSV** budget | Matches the track brief: "stable value to pay with" |
| Python | **TypeScript** | Track requires BSV's TypeScript stack |
| BSV testnet | **Mainnet** | BSV Association gave mainnet sats; the track accepts both |
| x402 | **BRC-105** (BSV's 402 standard) | The official BSV protocol |
| API3 price oracle | Replay + optional **CoinGecko** | Scope; time |
| 2 sellers | 1 seller | Scope; a second seller is a "could do" |
| Hedge-only command line | + **Dashboard with BSV Desktop funding** | Track requires user flows through a standard wallet |

**Bugs found in live mainnet runs, all fixed**

| Bug | Symptom | Fix |
|---|---|---|
| Units | LLM read sats as dollars ("$10/min") | Every amount in sats and dollars + premium/fair ratio |
| HTTP 431 | Payment header too big → **~2,300 sats paid without coverage** | Seller accepts headers up to 4 MB |
| Cheap protection skipped | The agent bought only once it was already expensive | Negligible premiums stay on |
| Purchase cap | Re-entry (3-minute prepay) blocked | Cap raised to 5,000 |
| Late start | Market ran before the agent connected | Clock waits for the first buyer |
| Ledger lost on Ctrl+C | Txids gone | Saved to a file every step |
| BEEF depth | "Maximum BEEF depth exceeded. Limit is 12" | Wallet monitor now runs |

---

## 12. Known weaknesses (say them before the judges do)

1. **Prices:** the demo replays a scripted crash. Live CoinGecko exists but rarely crashes in 6 minutes.
   A single price source decides payouts → production needs a signed oracle (several sources).
2. **Seller trust:** payouts are not yet guaranteed by a script.
3. **Insurance has a cost:** on average the buyer pays the seller's margin. The value is stability, not profit.
4. **Tiny amounts** (≈ $0.06 protected). Raise `PROTECT_SATS` for readable numbers.
5. **LLM is not perfectly consistent;** the safety layer and rules keep it safe.
6. **The seller keeps state in memory:** a restart forgets coverage (the ledger file remains).
7. **Regulation:** selling insurance/options to the public would need a licence or regulated partner.

---

## 13. Running the demo

```powershell
npx tsx hedge/run-seller.ts            # terminal 1, wait for "monitor running"
npx tsx hedge/run-agent.ts --wait      # terminal 2, wait for "monitor running"
npx vite dashboard                     # terminal 3, then open http://localhost:5174
```

On the page: Connect BSV Desktop → Fund agent → Start agent. A full run takes ~6 minutes.
All commands run from the project folder (`bsv21-token-kit`), never from `C:\Users\SBS`.

---

## 14. Glossary

| Term | Meaning |
|---|---|
| **sat** | 1/100,000,000 BSV |
| **floor** | Price level below which covered minutes are paid out |
| **premium** | Price of one minute of protection |
| **payout / claim** | Seller pays the agent the loss below the floor |
| **put option** | The right to sell at a fixed price; our protection is a 1-minute put |
| **volatility** | How much the price moves per minute |
| **adverse selection** | Buyers only buying when they know danger is coming |
| **collateral** | The seller's sats set aside to pay claims |
| **402** | HTTP "Payment Required": the server names a price, the client pays and retries |
| **BEEF** | A transaction packaged with its unconfirmed parents and proofs |
| **SPV** | Verifying a payment with proofs, without a full node |
| **0-conf** | Accepting a payment before it is in a block |
| **monitor** | Background service of the wallet that tracks confirmations |
| **non-custodial** | Nobody holds someone else's funds |

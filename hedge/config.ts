/** All demo settings in one place. Values can be overridden with environment variables (.env). */
const num = (name: string, fallback: number): number => {
  const v = process.env[name]
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback
}

export const CONFIG = {
  // ---- market / seller ----
  /** Real seconds per "minute" of the replayed market. */
  stepSeconds: num('STEP_SECONDS', 15),
  /** Floor = this fraction of the price when a buyer first buys. */
  floorPct: num('FLOOR_PCT', 0.97),
  /** Seller margin over the fair 1-minute put value. */
  sellerMargin: num('SELLER_MARGIN', 0.25),
  /** Minimum premium per minute (keeps premiums above network fees). */
  minPremiumSats: num('MIN_PREMIUM_SATS', 10),
  /** Adverse-selection defence: a NEW buyer must prepay this many minutes. */
  minMinutes: num('MIN_MINUTES', 3),
  /** Coverage cap per buyer, in sats of BSV protected. */
  maxProtectedSats: num('MAX_PROTECTED_SATS', 1_000_000),
  sellerPort: num('SELLER_PORT', 8090),

  // ---- agent ----
  /** Size of the agent's BSV treasury that it wants to keep stable (sats). */
  protectSats: num('PROTECT_SATS', 200_000),
  /** Total premium budget for the session (sats). */
  budgetSats: num('BUDGET_SATS', 10_000),
  /** Hard cap on a single purchase (sats). */
  maxPurchaseSats: num('MAX_PURCHASE_SATS', 2_000),
  /** User accepts paying up to this multiple of the agent's own fair-value estimate. */
  riskAversion: num('RISK_AVERSION', 2.0),
  /** Optional: downside volatility per minute (%) the user is comfortable with; 0 = always full cover. */
  targetVolPct: num('TARGET_VOL_PCT', 0),
  /** Stop after this many steps (0 = until the market replay ends). */
  maxSteps: num('MAX_STEPS', 0),
  sellerUrl: process.env.SELLER_URL ?? 'http://localhost:8090',
  /** If set, the agent only pays this seller (allowlist). */
  sellerIdentityKey: process.env.SELLER_IDENTITY_KEY ?? '',
  groqModel: process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b'
}

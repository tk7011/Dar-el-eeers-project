
export interface LivePrice {
  price: number
  updatedAt: number
}

const BASE_URL = 'https://api.coingecko.com/api/v3'
const COIN_ID = 'bitcoin-cash-sv'

async function requestJson(path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/json'
  }

  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    headers,
    signal: AbortSignal.timeout(10000)
  })

  if (!response.ok) {
    throw new Error(`CoinGecko request failed: HTTP ${response.status}`)
  }

  return response.json()
}

export async function fetchLiveBsvPrice(): Promise<LivePrice> {
  const data = await requestJson(
    `/simple/price?ids=${COIN_ID}&vs_currencies=usd&include_last_updated_at=true`
  )

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid CoinGecko response')
  }

  const coin = (data as Record<string, unknown>)[COIN_ID]

  if (!coin || typeof coin !== 'object') {
    throw new Error('BSV data missing')
  }

  const entry = coin as Record<string, unknown>
  const price = entry.usd
  const updatedAt = entry.last_updated_at

  if (
    typeof price !== 'number' ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error('Invalid BSV price')
  }

  if (
    typeof updatedAt !== 'number' ||
    !Number.isInteger(updatedAt)
  ) {
    throw new Error('Invalid price timestamp')
  }

  const age = Math.floor(Date.now() / 1000) - updatedAt

  if (age < -60 || age > 600) {
    throw new Error(`Stale market data: ${age} seconds old`)
  }

  return { price, updatedAt }
}

export async function fetchBsvHistory(): Promise<LivePrice[]> {
  const data = await requestJson(
    `/coins/${COIN_ID}/market_chart?vs_currency=usd&days=1`
  )

  if (!data || typeof data !== 'object') {
    throw new Error('Invalid historical price response')
  }

  const rows = (data as Record<string, unknown>).prices

  if (!Array.isArray(rows)) {
    throw new Error('Historical prices are missing')
  }

  const observations: LivePrice[] = []

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue

    const [timestamp, price] = row

    if (
      typeof timestamp !== 'number' ||
      typeof price !== 'number' ||
      !Number.isFinite(timestamp) ||
      !Number.isFinite(price) ||
      price <= 0
    ) {
      continue
    }

    observations.push({
      price,
      updatedAt: Math.floor(timestamp / 1000)
    })
  }

  observations.sort((a, b) => a.updatedAt - b.updatedAt)

  const unique = observations.filter(
    (point, index, all) =>
      index === 0 ||
      point.updatedAt !== all[index - 1].updatedAt
  )

  if (unique.length < 21) {
    throw new Error('Not enough historical observations')
  }

  const history = unique.slice(-21)
  const latest = history[history.length - 1]
  const age = Math.floor(Date.now() / 1000) - latest.updatedAt

  if (age < -60 || age > 1200) {
    throw new Error('Historical market data is stale')
  }

  return history
}

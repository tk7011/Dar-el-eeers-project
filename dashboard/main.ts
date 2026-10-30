/**
 * Agent Hedge dashboard. Reads the seller (/market, /ledger) and the agent (/info, /events) every 2 seconds.
 * "Fund agent" pays the agent's wallet from the user's BSV Desktop (BRC-29); the agent verifies and internalizes it.
 * URLs can be changed with ?seller=http://host:8090&agent=http://host:8091
 */
import { WalletClient } from '@bsv/sdk'
import { createBrc29Payment } from '../client/payments'

const params = new URLSearchParams(location.search)
const SELLER = params.get('seller') ?? 'http://localhost:8090'
const AGENT = params.get('agent') ?? 'http://localhost:8091'
const WOC = 'https://whatsonchain.com/tx/'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const shortTx = (t: string): string => `<a href="${WOC}${esc(t)}" target="_blank" rel="noopener" class="mono">${esc(t.slice(0, 10))}…</a>`
const fmtUsd = (v: number): string => `$${v.toFixed(4)}`
const fmtSats = (v: number): string => `${Math.round(v).toLocaleString('en-US')} sats`

let wallet: WalletClient | null = null
let agentInfo: any = null

// ---------------------------------------------------------------- wallet actions

$('connect').addEventListener('click', async () => {
  try {
    wallet = new WalletClient('auto')
    await wallet.waitForAuthentication({})
    const { publicKey } = await wallet.getPublicKey({ identityKey: true })
    $('chip-wallet').innerHTML = `BSV Desktop: <b>connected</b>`
    $('wallet-msg').textContent = `Your identity key: ${publicKey}`
    ;($('fund') as HTMLButtonElement).disabled = false
  } catch (e) {
    $('wallet-msg').innerHTML = `<span class="err">Could not connect: ${esc((e as Error).message)}. Is BSV Desktop open and unlocked?</span>`
  }
})

$('fund').addEventListener('click', async () => {
  if (wallet === null || agentInfo === null) return
  const amount = Math.floor(Number(($('amount') as HTMLInputElement).value))
  if (!(amount > 0)) return
  const btn = $('fund') as HTMLButtonElement
  btn.disabled = true
  $('wallet-msg').textContent = `Approve the payment of ${amount} sats in BSV Desktop…`
  try {
    const payment = await createBrc29Payment(wallet, agentInfo.identityKey, amount, 'Fund hedging agent')
    const res = await fetch(`${AGENT}/fund`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payment) })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    $('wallet-msg').innerHTML = `Agent funded with ${fmtSats(amount)} · new balance ${fmtSats(body.balance)} · ${shortTx(payment.txid)}`
  } catch (e) {
    $('wallet-msg').innerHTML = `<span class="err">Funding failed: ${esc((e as Error).message)}</span>`
  } finally {
    btn.disabled = false
  }
})

$('start').addEventListener('click', async () => {
  try { await fetch(`${AGENT}/start`, { method: 'POST' }) } catch { /* agent offline */ }
})

// ---------------------------------------------------------------- charts (plain SVG)

interface Series { name: string, color: string, points: Array<[number, number]>, dash?: boolean, fmt: (v: number) => string }

function lineChart (el: HTMLElement, series: Series[], markers: Array<{ x: number, y: number, label: string }>, hoverExtra: (x: number) => string = () => ''): void {
  const all = series.flatMap(s => s.points)
  if (all.length < 2) { el.innerHTML = '<p class="muted">Waiting for data…</p>'; return }
  const W = 560, H = 240, L = 58, R = 12, T = 10, B = 28
  const xs = all.map(p => p[0]), ys = all.map(p => p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  let y0 = Math.min(...ys), y1 = Math.max(...ys)
  const pad = (y1 - y0) * 0.12 || Math.abs(y1) * 0.01 || 1
  y0 -= pad; y1 += pad
  const sx = (x: number): number => L + (x1 === x0 ? 0 : (x - x0) / (x1 - x0)) * (W - L - R)
  const sy = (y: number): number => T + (1 - (y - y0) / (y1 - y0)) * (H - T - B)
  const ticks = [0, 1, 2, 3].map(i => y0 + (y1 - y0) * (i / 3))
  const fmtY = series[0].fmt
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(s => s.name).join(', '))} over time">`
  for (const t of ticks) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}" stroke="var(--border)" stroke-width="1"/>`
    svg += `<text x="${L - 6}" y="${sy(t) + 4}" text-anchor="end" font-size="11" fill="var(--text-3)">${esc(fmtY(t))}</text>`
  }
  svg += `<text x="${L}" y="${H - 8}" font-size="11" fill="var(--text-3)">step ${x0}</text>`
  svg += `<text x="${W - R}" y="${H - 8}" text-anchor="end" font-size="11" fill="var(--text-3)">step ${x1}</text>`
  for (const s of series) {
    const d = s.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('')
    svg += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" ${s.dash === true ? 'stroke-dasharray="5 4"' : ''}/>`
  }
  for (const m of markers) {
    svg += `<circle cx="${sx(m.x)}" cy="${sy(m.y)}" r="5" fill="var(--protected)" stroke="var(--surface)" stroke-width="2"><title>${esc(m.label)}</title></circle>`
  }
  svg += `<line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" stroke="var(--text-3)" stroke-width="1" visibility="hidden"/>`
  svg += `<rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="hit"/></svg><div class="tip"></div>`
  el.innerHTML = svg

  const svgEl = el.querySelector('svg') as SVGSVGElement
  const cross = el.querySelector('.cross') as SVGLineElement
  const tip = el.querySelector('.tip') as HTMLDivElement
  const hit = el.querySelector('.hit') as SVGRectElement
  hit.addEventListener('mousemove', ev => {
    const box = svgEl.getBoundingClientRect()
    const vx = (ev.clientX - box.left) / box.width * W
    const xv = Math.round(x0 + (vx - L) / (W - L - R) * (x1 - x0))
    cross.setAttribute('x1', String(sx(xv))); cross.setAttribute('x2', String(sx(xv))); cross.setAttribute('visibility', 'visible')
    const rows = series.map(s => {
      const p = s.points.find(q => q[0] === xv)
      return p === undefined ? '' : `<div>${esc(s.name)}: <b>${esc(s.fmt(p[1]))}</b></div>`
    }).join('')
    tip.innerHTML = `<div>Step ${xv}</div>${rows}${hoverExtra(xv)}`
    tip.style.display = 'block'
    const left = ev.clientX - box.left + 12
    tip.style.left = `${Math.min(left, box.width - tip.offsetWidth - 4)}px`
    tip.style.top = `${ev.clientY - box.top - 10}px`
  })
  hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden') })
}

// ---------------------------------------------------------------- polling + render

async function getJson (url: string): Promise<any> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

async function refresh (): Promise<void> {
  const [market, ledger, info, events] = await Promise.all([
    getJson(`${SELLER}/market`).catch(() => null),
    getJson(`${SELLER}/ledger`).catch(() => null),
    getJson(`${AGENT}/info`).catch(() => null),
    getJson(`${AGENT}/events`).catch(() => [])
  ])
  agentInfo = info
  $('chip-seller').innerHTML = market === null ? 'Seller: <b>offline</b>' : `Seller: <b>${esc(market.source ?? 'replay')}</b> · step ${market.step}`
  $('chip-agent').innerHTML = info === null ? 'Agent: <b>offline</b>' : `Agent: <b>${esc(info.status)}</b> · ${esc(info.wallet)}`
  ;($('start') as HTMLButtonElement).disabled = info === null || info.status !== 'waiting'
  if (market === null) return

  const me = info?.identityKey as string | undefined
  const buyer = ledger?.buyers?.find((b: any) => b.id === me) ?? ledger?.buyers?.[0]
  const mine = (ledger?.ledger ?? []).filter((e: any) => buyer === undefined || e.buyer === buyer.id)
  const protectSats = Number(info?.settings?.protectSats ?? 200_000)
  const firstStep = market.step - market.history.length + 1
  const pricePts: Array<[number, number]> = market.history.map((p: number, i: number) => [firstStep + i, p])
  const decisions = (events as any[]).filter(e => e.kind === 'decision')
  const startStep = decisions.length > 0 ? Number(decisions[0].step) : market.step

  // treasury value with and without protection, from the on-chain ledger
  const valueSteps = pricePts.filter(p => p[0] >= startStep)
  const prot: Array<[number, number]> = []
  const unprot: Array<[number, number]> = []
  for (const [s, p] of valueSteps) {
    const paid = mine.filter((e: any) => e.kind === 'premium' && e.step <= s).reduce((a: number, e: any) => a + e.sats, 0)
    const got = mine.filter((e: any) => e.kind === 'payout' && e.step < s).reduce((a: number, e: any) => a + e.sats, 0)
    unprot.push([s, protectSats * p / 1e8])
    prot.push([s, (protectSats + got - paid) * p / 1e8])
  }

  const premiums = mine.filter((e: any) => e.kind === 'premium').reduce((a: number, e: any) => a + e.sats, 0)
  const payouts = mine.filter((e: any) => e.kind === 'payout').reduce((a: number, e: any) => a + e.sats, 0)
  const floor = buyer?.floor as number | undefined
  const lastProt = prot.at(-1)?.[1], lastUnprot = unprot.at(-1)?.[1], firstVal = unprot[0]?.[1]
  const kpis = [
    ['BSV price', fmtUsd(market.price), `step ${market.step}${market.done === true ? ' · finished' : ''}`],
    ['Protection floor', floor === undefined ? '-' : fmtUsd(floor), floor === undefined ? 'not protected yet' : `${((market.price / floor - 1) * 100).toFixed(2)}% from price`],
    ['Premiums paid', fmtSats(premiums), `${mine.filter((e: any) => e.kind === 'premium').length} payments`],
    ['Payouts received', fmtSats(payouts), `${mine.filter((e: any) => e.kind === 'payout').length} payouts`],
    ['Value with protection', lastProt === undefined ? '-' : fmtUsd(lastProt), firstVal === undefined || lastProt === undefined ? '' : `${((lastProt / firstVal - 1) * 100).toFixed(2)}% since start`],
    ['Value without protection', lastUnprot === undefined ? '-' : fmtUsd(lastUnprot), firstVal === undefined || lastUnprot === undefined ? '' : `${((lastUnprot / firstVal - 1) * 100).toFixed(2)}% since start`],
    ['Agent wallet', info === null ? '-' : fmtSats(info.balance), info === null ? 'agent offline' : `budget ${fmtSats(info.settings.budgetSats)}`]
  ]
  $('kpis').innerHTML = kpis.map(([l, v, n]) => `<div class="kpi"><div class="label">${esc(l)}</div><div class="value">${esc(v)}</div><div class="note">${esc(n)}</div></div>`).join('')

  const byStep = new Map(decisions.map(d => [Number(d.step), d]))
  const floorPts: Array<[number, number]> = floor === undefined ? [] : pricePts.map(p => [p[0], floor])
  lineChart($('price-chart'),
    [
      { name: 'BSV/USD', color: 'var(--price)', points: pricePts, fmt: fmtUsd },
      ...(floor === undefined ? [] : [{ name: 'Floor', color: 'var(--floor)', points: floorPts, dash: true, fmt: fmtUsd }])
    ],
    mine.filter((e: any) => e.kind === 'payout').map((e: any) => ({ x: e.step + 1, y: e.price, label: `Payout ${e.sats} sats` })),
    x => { const d = byStep.get(x); return d === undefined ? '' : `<div>Agent: <b>${esc(d.decision?.action)}</b>${d.premiumTx !== undefined ? ' (paid)' : ''}</div>` }
  )
  lineChart($('value-chart'), [
    { name: 'With protection', color: 'var(--protected)', points: prot, fmt: fmtUsd },
    { name: 'Without protection', color: 'var(--unprotected)', points: unprot, fmt: fmtUsd }
  ], [])

  // decision feed, newest first
  const feed = (events as any[]).slice().reverse().map(e => {
    if (e.kind === 'payout') return `<div class="item"><div class="top"><span class="badge payout">PAYOUT</span><b>+${fmtSats(e.sats)}</b>${shortTx(e.txid)}</div></div>`
    if (e.kind === 'funding') return `<div class="item"><div class="top"><span class="badge funding">FUNDED</span><b>${fmtSats(e.sats)}</b> from BSV Desktop ${shortTx(e.txid)}</div></div>`
    const d = e.decision ?? {}
    const cls = e.blocked !== undefined ? 'blocked' : e.premiumTx !== undefined ? 'buy' : 'skip'
    const label = cls === 'blocked' ? 'BLOCKED' : cls === 'buy' ? 'BOUGHT' : 'SKIPPED'
    return `<div class="item"><div class="top"><span class="badge ${cls}">${label}</span><b>Step ${esc(e.step)}</b>
      <span class="muted">${fmtUsd(Number(e.price))} · quote ${esc(e.quotePremium)} sats/${esc(e.quoteMinutes)} min · by ${esc(d.by)}</span>
      ${e.premiumTx !== undefined ? shortTx(e.premiumTx) : ''}</div>
      <div class="reason">${esc(d.reason)}</div>${e.blocked !== undefined ? `<div class="reason err">Blocked by code: ${esc(e.blocked)}</div>` : ''}</div>`
  }).join('')
  $('feed').innerHTML = feed === '' ? '<p class="muted">Waiting for the agent…</p>' : feed

  const rows = mine.slice().reverse().map((e: any) => `<tr><td>${e.step}</td><td>${e.kind === 'premium' ? 'Premium' : 'Payout'}</td><td>${e.sats.toLocaleString('en-US')}</td><td>${fmtUsd(e.price)}</td><td>${shortTx(e.txid)}</td></tr>`).join('')
  $('ledger').innerHTML = rows === '' ? '<tr><td colspan="5" class="muted">No transactions yet</td></tr>' : rows
}

const loop = async (): Promise<void> => {
  try { await refresh() } catch (e) { console.error(e) }
  setTimeout(() => { void loop() }, 2000)
}
void loop()

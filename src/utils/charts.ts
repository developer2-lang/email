/**
 * Lightweight canvas chart renderers used by the Dashboard and Analytics tabs.
 * Charts are drawn imperatively on `<canvas>` elements via refs.
 *
 * Every chart draws ONLY the real data passed in by the caller — there are no
 * hardcoded values, no fake fallback series, and no invented categories. When
 * there is nothing to draw the UI shows its own empty state.
 */

interface CanvasContext {
  ctx: CanvasRenderingContext2D
  width: number
  height: number
}

export interface Segment {
  label: string
  value: number
  color: string
}

function truncate(text: string, max: number): string {
  const trimmed = text || ''
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function prepCanvas(canvas: HTMLCanvasElement): CanvasContext | null {
  const rect = canvas.getBoundingClientRect()
  const width = rect.width || canvas.clientWidth || 300
  const height = rect.height || canvas.clientHeight || 150
  const dpr = window.devicePixelRatio || 1

  const pw = Math.max(1, Math.round(width * dpr))
  const ph = Math.max(1, Math.round(height * dpr))
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw
    canvas.height = ph
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, pw, ph)
  ctx.scale(dpr, dpr)

  return { ctx, width, height }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function drawHorizontalGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  padL: number,
  padR: number,
  padT: number,
  padB: number,
  divisions: number,
): void {
  const chartH = height - padT - padB
  ctx.font = '10px sans-serif'
  for (let i = 0; i <= divisions; i++) {
    const y = padT + (chartH * i) / divisions
    ctx.strokeStyle = '#EEF2F7'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(padL, Math.round(y) + 0.5)
    ctx.lineTo(width - padR, Math.round(y) + 0.5)
    ctx.stroke()
  }
}

function drawLegendDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
  label: string,
): void {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(x, y, 4, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#64748B'
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(label, x + 8, y + 3.5)
}

/**
 * Grouped bar chart of OPEN % vs CLICK % for the most recent sent campaigns
 * (Dashboard). Expects a caller-prepared list — campaigns already filtered to
 * the most recent sent campaigns — and draws ONLY real rows. When the list is
 * empty it draws nothing (the UI renders its own empty state).
 *
 * Both bars are engagement RATES (percentages), not raw counts: open % is
 * opened / delivered (or sent) × 100 and click % is clicked / delivered (or
 * sent) × 100 — using the application's existing campaign metrics. The Y-axis
 * is a clean percentage scale derived from the real data (it grows past 70%
 * automatically when a campaign exceeds it). Long campaign names are truncated
 * and drawn at a slight diagonal so they stay readable. Hovering a campaign
 * shows a tooltip with the full name, open % and click %.
 */

interface PerfLayout {
  rows: any[]
  padL: number
  padR: number
  padT: number
  padB: number
  chartW: number
  chartH: number
  max: number
  n: number
  slot: number
}

interface PerfChartCanvas extends HTMLCanvasElement {
  __perfLayout?: PerfLayout
  __perfHover?: number
  __perfHoverBound?: boolean
}

interface PerfTip {
  w: number
  h: number
}

function rateOf(campaign: any, kind: 'open' | 'click'): number {
  const delivered = campaign.deliveredCount || campaign.sent || 0
  const count =
    kind === 'open'
      ? (campaign.openedCount ?? campaign.opened ?? 0)
      : (campaign.clickedCount ?? campaign.clicked ?? 0)
  if (delivered > 0) return (count / delivered) * 100
  const stored = kind === 'open' ? campaign.openRate : campaign.clickRate
  if (typeof stored === 'number' && isFinite(stored)) return stored
  return 0
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1
  const exp = Math.floor(Math.log10(raw))
  const base = Math.pow(10, exp)
  const f = raw / base
  let nf: number
  if (f <= 1) nf = 1
  else if (f <= 2) nf = 2
  else if (f <= 5) nf = 5
  else nf = 10
  return nf * base
}

function measurePerfTooltip(ctx: CanvasRenderingContext2D, campaign: any): PerfTip {
  const name = truncate(String(campaign.name || 'Campaign'), 26)
  ctx.font = '700 11px sans-serif'
  const nameW = ctx.measureText(name).width
  ctx.font = '11px sans-serif'
  const labelW = Math.max(ctx.measureText('Open %').width, ctx.measureText('Click %').width)
  ctx.font = '700 11px sans-serif'
  const openedW = ctx.measureText(`${(campaign.openPct || 0).toFixed(1)}%`).width
  const clickedW = ctx.measureText(`${(campaign.clickPct || 0).toFixed(1)}%`).width
  const metricW = 14 + labelW + 10 + Math.max(openedW, clickedW)
  return { w: Math.round(Math.max(172, nameW + 20, metricW + 24)), h: 64 }
}

function drawPerfTooltip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  campaign: any,
  tip: PerfTip,
): void {
  const padX = 10
  const padY = 9

  ctx.save()
  ctx.shadowColor = 'rgba(15, 23, 42, 0.12)'
  ctx.shadowBlur = 14
  ctx.shadowOffsetY = 4
  ctx.fillStyle = '#FFFFFF'
  roundRect(ctx, x, y, tip.w, tip.h, 8)
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = '#E2E8F0'
  ctx.lineWidth = 1
  roundRect(ctx, x, y, tip.w, tip.h, 8)
  ctx.stroke()

  ctx.textAlign = 'left'
  ctx.font = '700 11px sans-serif'
  ctx.fillStyle = '#334155'
  ctx.fillText(truncate(String(campaign.name || 'Campaign'), 26), x + padX, y + padY + 11)

  const metrics: Array<[string, number, string]> = [
    ['Open %', 0x2563eb, `${(campaign.openPct || 0).toFixed(1)}%`],
    ['Click %', 0x10b981, `${(campaign.clickPct || 0).toFixed(1)}%`],
  ]
  metrics.forEach(([label, color, valueText], i) => {
    const ty = y + padY + 26 + i * 16
    ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`
    ctx.beginPath()
    ctx.arc(x + padX + 3.5, ty - 4, 3.5, 0, Math.PI * 2)
    ctx.fill()

    ctx.font = '11px sans-serif'
    ctx.fillStyle = '#64748B'
    ctx.fillText(label, x + padX + 12, ty)

    ctx.font = '700 11px sans-serif'
    ctx.fillStyle = '#334155'
    ctx.fillText(valueText, x + tip.w - padX - ctx.measureText(valueText).width, ty)
  })
}

function attachPerfListeners(canvas: PerfChartCanvas): void {
  if (canvas.__perfHoverBound) return
  canvas.__perfHoverBound = true

  const redraw = () => {
    const layout = canvas.__perfLayout
    if (layout) drawPerformanceChart(canvas, layout.rows)
  }

  canvas.addEventListener('mousemove', (e) => {
    const layout = canvas.__perfLayout
    if (!layout) return
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    let index = -1
    if (
      y >= layout.padT &&
      y <= layout.padT + layout.chartH &&
      x >= layout.padL &&
      x <= layout.padL + layout.chartW
    ) {
      index = Math.floor((x - layout.padL) / layout.slot)
      if (index < 0) index = 0
      if (index >= layout.n) index = layout.n - 1
    }
    if (index !== canvas.__perfHover) {
      canvas.__perfHover = index
      redraw()
    }
  })

  canvas.addEventListener('mouseleave', () => {
    if ((canvas.__perfHover ?? -1) !== -1) {
      canvas.__perfHover = -1
      redraw()
    }
  })

  const container = canvas.parentElement
  if (container) container.addEventListener('scroll', redraw)
}

export function drawPerformanceChart(canvas: HTMLCanvasElement, campaigns: any[]): void {
  const rows = (campaigns || [])
    .filter((c) => c && String(c.status || '').toLowerCase() === 'sent')
    .slice(-6)
    .map((c) => ({ ...c, openPct: rateOf(c, 'open'), clickPct: rateOf(c, 'click') }))
  if (rows.length === 0) return

  const el = canvas as PerfChartCanvas

  const container = canvas.parentElement
  const containerW = container ? container.clientWidth : canvas.clientWidth || 300

  // Reserve enough horizontal room per campaign so labels never squeeze
  // together; when that exceeds the card width the chart becomes scrollable.
  const padL0 = 44
  const MIN_SLOT = 96
  const targetW = Math.max(containerW, padL0 + 130 + rows.length * MIN_SLOT)
  const scrollable = targetW > containerW

  canvas.style.display = 'block'
  canvas.style.height = '100%'
  canvas.style.width = scrollable ? `${targetW}px` : '100%'
  canvas.style.cursor = 'crosshair'

  const prep = prepCanvas(canvas)
  if (!prep) return
  const { ctx, width, height } = prep

  // Y-axis percentage scale derived from the real rates.
  const maxRate = Math.max(...rows.map((c) => Math.max(c.openPct, c.clickPct)), 0)
  const niceMax = Math.max(10, Math.ceil(maxRate / 10) * 10)
  const step = niceStep(Math.max(1, Math.round(niceMax / 7)))
  const divisions = Math.max(1, Math.ceil(niceMax / step))

  const small = width < 520
  const maxChars = small ? 16 : 20
  const angle = (30 * Math.PI) / 180
  const labelH = Math.ceil(maxChars * 5.4 * Math.sin(angle))
  const labelW = Math.ceil(maxChars * 5.4 * Math.cos(angle))

  ctx.font = '10px sans-serif'
  const padL = Math.max(padL0, ctx.measureText(`${niceMax}%`).width + 12)
  const padR = 18 + labelW
  const padT = 26
  const padB = 22 + labelH

  const chartW = width - padL - padR
  const chartH = height - padT - padB

  el.__perfLayout = {
    rows,
    padL,
    padR,
    padT,
    padB,
    chartW,
    chartH,
    max: niceMax,
    n: rows.length,
    slot: chartW / rows.length,
  }

  drawHorizontalGrid(ctx, width, height, padL, padR, padT, padB, divisions)

  // Y-axis percentage labels (0% → niceMax%).
  ctx.font = '10px sans-serif'
  ctx.fillStyle = '#94A3B8'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let i = 0; i <= divisions; i++) {
    const value = step * i
    const y = padT + chartH - (chartH * i) / divisions
    ctx.fillText(`${Math.round(value)}%`, padL - 7, y)
  }
  ctx.textBaseline = 'alphabetic'

  const n = rows.length
  const slot = chartW / n
  const groupW = Math.min(42, slot * 0.5)
  const barW = Math.max(6, groupW / 2 - 3)
  const hoverIndex = el.__perfHover ?? -1

  rows.forEach((campaign, i) => {
    const cx = padL + slot * i + slot / 2
    const isHovered = i === hoverIndex

    const drawBar = (value: number, x: number, color: string) => {
      const barHeight = Math.max(2, (value / niceMax) * chartH)
      const y = padT + chartH - barHeight
      ctx.fillStyle = color
      ctx.globalAlpha = isHovered ? 1 : 0.88
      roundRect(ctx, x, y, barW, barHeight, Math.min(5, barW / 2))
      ctx.fill()
      ctx.globalAlpha = 1
    }

    drawBar(campaign.openPct, cx - barW - 2, '#2563EB')
    drawBar(campaign.clickPct, cx + 2, '#10B981')
  })

  // X-axis labels — truncated + slight diagonal rotation (readability for long names).
  ctx.fillStyle = '#64748B'
  ctx.font = `${small ? 9 : 10}px sans-serif`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  rows.forEach((campaign, i) => {
    const cx = padL + slot * i + slot / 2
    const label = truncate(String(campaign.name || 'Campaign'), maxChars)
    ctx.save()
    ctx.translate(cx, padT + chartH + 6)
    ctx.rotate(angle)
    ctx.fillText(label, 0, 0)
    ctx.restore()
  })
  ctx.textBaseline = 'alphabetic'

  // Legend (top-right) — pinned to the visible card width.
  const scrollLeft = container ? container.scrollLeft : 0
  const legendRight = Math.min(width, (container ? container.clientWidth : width) + scrollLeft)
  drawLegendDot(ctx, legendRight - 152, 12, '#2563EB', 'Open %')
  drawLegendDot(ctx, legendRight - 80, 12, '#10B981', 'Click %')

  // Hover tooltip (full campaign name + open % / click %).
  if (hoverIndex >= 0 && hoverIndex < rows.length) {
    const campaign = rows[hoverIndex]
    const cx = padL + slot * hoverIndex + slot / 2
    const taller = Math.max(campaign.openPct, campaign.clickPct)
    const yTop = padT + chartH - (taller / niceMax) * chartH
    const tip = measurePerfTooltip(ctx, campaign)

    let tipX = cx + 14
    if (tipX + tip.w > width - 4) tipX = cx - 14 - tip.w
    tipX = Math.max(4, Math.min(tipX, width - tip.w - 4))

    let tipY = Math.max(4, yTop - tip.h - 10)
    if (tipY + tip.h > height - 4) tipY = height - tip.h - 4

    drawPerfTooltip(ctx, tipX, tipY, campaign, tip)
  }

  attachPerfListeners(el)
}

/**
 * Dual-line chart of Open Rate % and Click Rate % over time (Analytics).
 * Both series are derived from the caller's real trend points — the Y axis is
 * a fixed 0–100% scale so rates read intuitively against each other. Empty
 * input draws nothing (the UI renders its own empty state).
 */
export function drawRateTrendChart(
  canvas: HTMLCanvasElement,
  points: Array<{ label: string; open_rate: number; click_rate: number }>,
): void {
  if (!points || points.length === 0) return

  const prep = prepCanvas(canvas)
  if (!prep) return
  const { ctx, width, height } = prep

  const padL = 40
  const padR = 14
  const padT = 20
  const padB = 28
  const chartW = width - padL - padR
  const chartH = height - padT - padB

  const maxY = 100 // fixed percentage scale

  drawHorizontalGrid(ctx, width, height, padL, padR, padT, padB, 4)

  // Y-axis labels (0%–100%).
  ctx.font = '10px sans-serif'
  ctx.fillStyle = '#94A3B8'
  ctx.textAlign = 'right'
  for (let i = 0; i <= 4; i++) {
    const y = padT + chartH - (chartH * i) / 4
    ctx.fillText(`${Math.round((maxY * i) / 4)}%`, padL - 6, y + 3)
  }

  const n = points.length
  const step = n > 1 ? chartW / (n - 1) : 0

  const series = (get: (p: (typeof points)[number]) => number) =>
    points.map((p, i) => ({
      x: padL + step * i,
      y: padT + chartH - (Math.max(0, Math.min(100, get(p))) / maxY) * chartH,
    }))

  const drawSeriesLine = (coords: Array<{ x: number; y: number }>, color: string) => {
    ctx.strokeStyle = color
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    coords.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)))
    ctx.stroke()

    coords.forEach((pt) => {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 3.2, 0, Math.PI * 2)
      ctx.fill()
    })
  }

  const openCoords = series((p) => p.open_rate)
  const clickCoords = series((p) => p.click_rate)

  // Open rate area fill (soft blue).
  if (openCoords.length > 0) {
    const gradient = ctx.createLinearGradient(0, padT, 0, padT + chartH)
    gradient.addColorStop(0, 'rgba(37,99,235,0.16)')
    gradient.addColorStop(1, 'rgba(37,99,235,0.02)')
    ctx.beginPath()
    ctx.moveTo(openCoords[0].x, padT + chartH)
    openCoords.forEach((pt) => ctx.lineTo(pt.x, pt.y))
    ctx.lineTo(openCoords[openCoords.length - 1].x, padT + chartH)
    ctx.closePath()
    ctx.fillStyle = gradient
    ctx.fill()
  }

  drawSeriesLine(openCoords, '#2563EB')
  drawSeriesLine(clickCoords, '#10B981')

  // Value labels on points (only when the chart is wide enough to avoid clutter).
  ctx.font = '700 9px sans-serif'
  ctx.textAlign = 'center'
  if (n <= 12) {
    openCoords.forEach((pt, i) => {
      ctx.fillStyle = '#334155'
      ctx.fillText(`${Math.round(points[i].open_rate)}%`, pt.x, pt.y - 7)
    })
    clickCoords.forEach((pt, i) => {
      ctx.fillStyle = '#047857'
      ctx.fillText(`${Math.round(points[i].click_rate)}%`, pt.x, pt.y + 13)
    })
  }

  // X-axis labels — thin to the real dates; skip duplicates when crowded.
  const labelEvery = Math.max(1, Math.ceil(n / 8))
  ctx.font = '10px sans-serif'
  ctx.fillStyle = '#64748B'
  ctx.textAlign = 'center'
  points.forEach((p, i) => {
    if (i % labelEvery !== 0) return
    const x = padL + step * i
    ctx.fillText(truncate(p.label, 12), x, height - 8)
  })

  drawLegendDot(ctx, padL + 4, 10, '#2563EB', 'Open Rate')
  drawLegendDot(ctx, padL + 84, 10, '#10B981', 'Click Rate')
}

/**
 * Doughnut chart of real contact-category counts (Analytics). The segments are
 * built from actual database values by the caller — no invented categories.
 * Draws "No data" inside the ring when the total is zero.
 */
export function drawAudienceDonut(canvas: HTMLCanvasElement, segments: Segment[]): void {
  const prep = prepCanvas(canvas)
  if (!prep) return
  const { ctx, width, height } = prep

  const cx = width / 2
  const cy = height / 2
  const outer = Math.min(width, height) / 2 - 6
  const inner = outer * 0.62
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)

  if (total === 0) {
    ctx.strokeStyle = '#E2E8F0'
    ctx.lineWidth = outer - inner
    ctx.beginPath()
    ctx.arc(cx, cy, (outer + inner) / 2, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#94A3B8'
    ctx.font = '600 11px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('No data', cx, cy + 4)
    return
  }

  let start = -Math.PI / 2
  segments.forEach((segment) => {
    if (segment.value <= 0) return
    const angle = (segment.value / total) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(cx, cy, outer, start, start + angle)
    ctx.arc(cx, cy, inner, start + angle, start, true)
    ctx.closePath()
    ctx.fillStyle = segment.color
    ctx.fill()
    start += angle
  })

  ctx.fillStyle = '#334155'
  ctx.font = '700 14px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(String(total), cx, cy - 1)

  ctx.fillStyle = '#94A3B8'
  ctx.font = '10px sans-serif'
  ctx.fillText('contacts', cx, cy + 13)
}

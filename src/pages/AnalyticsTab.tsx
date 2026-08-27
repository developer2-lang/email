import { useCallback, useEffect, useRef, useState } from 'react'
import type { TabKey } from '../types'
import {
  buildRange,
  fetchAnalyticsDashboard,
  rangeLabel,
} from '../services/analyticsService'
import type { AnalyticsDashboard, RangeKey } from '../services/analyticsService'
import { drawAudienceDonut, drawRateTrendChart } from '../utils/charts'

interface AnalyticsTabProps {
  onToast?: (msg: string, type?: string) => void
  onNavigate?: (tab: TabKey) => void
}

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'thisMonth', label: 'This month' },
]

const CARD_TONES = {
  blue: { iconBg: '#EFF6FF', iconFg: '#2563EB' },
  green: { iconBg: '#ECFDF5', iconFg: '#059669' },
  violet: { iconBg: '#F5F3FF', iconFg: '#7C3AED' },
  amber: { iconBg: '#FFFBEB', iconFg: '#D97706' },
} as const

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOUR_STEPS = [0, 6, 12, 18, 23]

function KpiCard({
  label,
  value,
  icon,
  tone,
  sub,
}: {
  label: string
  value: string
  icon: string
  tone: keyof typeof CARD_TONES
  sub: string
}) {
  const t = CARD_TONES[tone]
  return (
    <div className="dash-card">
      <div className="dash-card-top">
        <div className="dash-card-icon" style={{ background: t.iconBg, color: t.iconFg }}>
          {icon}
        </div>
      </div>
      <div className="dash-card-value">{value}</div>
      <div className="dash-card-label">{label}</div>
      <div className="dash-card-sub">{sub}</div>
    </div>
  )
}

function AnalyticsSkeleton() {
  return (
    <div className="page active">
      <div style={{ marginBottom: '22px' }}>
        <div className="skeleton" style={{ width: 200, height: 22 }}></div>
        <div className="skeleton" style={{ width: 300, height: 12, marginTop: 10 }}></div>
      </div>
      <div className="dash-cards">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton sk-card"></div>
        ))}
      </div>
      <div className="dash-main-grid">
        <div className="skeleton sk-block"></div>
        <div className="skeleton sk-block"></div>
      </div>
      <div className="dash-grid-2">
        <div className="skeleton sk-block"></div>
        <div className="skeleton sk-block"></div>
      </div>
    </div>
  )
}

function AnalyticsError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="page active">
      <div className="dash-error">
        <div className="dash-error-icon">⚠️</div>
        <div className="dash-error-title">Couldn't load analytics data</div>
        <div className="dash-error-sub">{message}</div>
        <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  )
}

function EmptyBlock({
  icon,
  title,
  sub,
}: {
  icon: string
  title: string
  sub: string
}) {
  return (
    <div className="dash-empty">
      <div className="dash-empty-icon">{icon}</div>
      <div className="dash-empty-title">{title}</div>
      <div className="dash-empty-sub">{sub}</div>
    </div>
  )
}

export default function AnalyticsTab(_props: AnalyticsTabProps) {
  const [rangeKey, setRangeKey] = useState<RangeKey>('30d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [data, setData] = useState<AnalyticsDashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState('')

  const trendRef = useRef<HTMLCanvasElement | null>(null)
  const donutRef = useRef<HTMLCanvasElement | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const range = buildRange(rangeKey, customFrom, customTo)
      const dashboard = await fetchAnalyticsDashboard(range)
      setData(dashboard)
      setLastUpdated(
        new Date().toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics')
    } finally {
      setLoading(false)
    }
  }, [rangeKey, customFrom, customTo])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    if (loading || !data) return
    const canvas = trendRef.current
    if (canvas && data.trend.length > 0) {
      drawRateTrendChart(canvas, data.trend)
    }
  }, [data, loading])

  useEffect(() => {
    if (loading || !data) return
    const canvas = donutRef.current
    if (canvas && data.audience.length > 0) {
      drawAudienceDonut(canvas, data.audience)
    }
  }, [data, loading])

  if (loading && !data) return <AnalyticsSkeleton />
  if (error && !data) return <AnalyticsError message={error} onRetry={() => void load()} />

  const rangeLabelText = data ? rangeLabel(data.range) : ''
  const kpis = data?.kpis
  const weekly = data?.trend_weekly ?? false

  // Heatmap scales derived from the real data.
  const heatMax = data && data.heatmap.length > 0
    ? Math.max(...data.heatmap.map((c) => c.opens))
    : 0
  const heatCells = new Map<string, { opens: number; clicks: number }>()
  for (const cell of data?.heatmap || []) {
    heatCells.set(`${cell.day}|${cell.hour}`, { opens: cell.opens, clicks: cell.clicks })
  }
  const heatmapHasData = (data?.heatmap_total || 0) > 0

  const seqMaxSent = data && data.sequences.length > 0
    ? Math.max(...data.sequences.map((s) => s.sent))
    : 0

  const pickRange = (key: RangeKey) => {
    setRangeKey(key)
    setCustomFrom('')
    setCustomTo('')
  }

  return (
    <div className="page active">
      {/* Header */}
      <div className="dash-header">
        <div>
          <div className="dash-greeting">Analytics</div>
          <div className="dash-subtitle">Campaign performance & engagement intelligence</div>
        </div>

        <div className="ana-controls">
          <div className="ana-range-group">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={`ana-range-btn ${rangeKey === opt.key ? 'active' : ''}`}
                onClick={() => pickRange(opt.key)}
              >
                {opt.label}
              </button>
            ))}
            <div className={`ana-range-btn ana-range-custom ${rangeKey === 'custom' ? 'active' : ''}`}>
              <input
                type="date"
                aria-label="Custom range start"
                value={customFrom}
                onChange={(e) => {
                  setCustomFrom(e.target.value)
                  setRangeKey('custom')
                }}
              />
              <span>–</span>
              <input
                type="date"
                aria-label="Custom range end"
                value={customTo}
                onChange={(e) => {
                  setCustomTo(e.target.value)
                  setRangeKey('custom')
                }}
              />
            </div>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? 'Refreshing…' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="dash-error" style={{ marginBottom: 16, padding: '16px 24px' }}>
          <div className="dash-error-title" style={{ fontSize: 13 }}>
            Couldn't refresh analytics — showing the last loaded data
          </div>
          <div className="dash-error-sub">{error}</div>
          <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {loading && data ? (
        <div className="dash-cards">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton sk-card"></div>
          ))}
        </div>
      ) : (
        kpis && (
          <>
            <div className="dash-cards">
              <KpiCard
                label="Total Sent"
                value={kpis.sent.toLocaleString()}
                icon="✉"
                tone="blue"
                sub={`${rangeLabelText} · ${kpis.failed} bounced`}
              />
              <KpiCard
                label="Open Rate"
                value={`${kpis.open_rate}%`}
                icon="👁"
                tone="green"
                sub={`${kpis.opened} of ${kpis.sent} delivered opened`}
              />
              <KpiCard
                label="Click Rate"
                value={`${kpis.click_rate}%`}
                icon="↗"
                tone="violet"
                sub={`${kpis.clicked} recipients clicked a link`}
              />
              <KpiCard
                label="Bounce Rate"
                value={`${kpis.bounce_rate}%`}
                icon="⚠"
                tone="amber"
                sub={`${kpis.failed} emails failed to deliver`}
              />
            </div>

            <div className="dash-main-grid">
              {/* Trend chart */}
              <div className="card dash-chart-card">
                <div className="dash-card-head">
                  <div>
                    <div className="dash-card-title">Open Rate & Click Rate Trend</div>
                    <div className="dash-card-subtitle">
                      {weekly ? 'Weekly engagement over the selected period' : 'Daily engagement over the selected period'}
                    </div>
                  </div>
                  {lastUpdated && (
                    <span className="ana-updated">Updated {lastUpdated}</span>
                  )}
                </div>
                {data.trend.length > 0 ? (
                  <div className="dash-chart-body">
                    <canvas ref={trendRef} id="analytics-trend-chart"></canvas>
                  </div>
                ) : (
                  <EmptyBlock
                    icon="📈"
                    title="No trend data yet"
                    sub="Send your first campaign or sequence emails to start seeing engagement analytics."
                  />
                )}
              </div>

              {/* Audience donut */}
              <div className="card dash-activity-card">
                <div className="dash-card-head">
                  <div>
                    <div className="dash-card-title">Contact Audience</div>
                    <div className="dash-card-subtitle">
                      {data.audience_total > 0
                        ? `${data.audience_total} contacts by real category`
                        : 'Distribution by contact category'}
                    </div>
                  </div>
                </div>
                {data.audience.length > 0 ? (
                  <>
                    <div className="ana-donut-wrap">
                      <div className="ana-donut-canvas">
                        <canvas ref={donutRef} id="analytics-donut-chart"></canvas>
                      </div>
                      <div className="ana-donut-legend">
                        {data.audience.map((seg) => (
                          <div className="ana-legend-row" key={seg.label}>
                            <span className="ana-legend-dot" style={{ background: seg.color }}></span>
                            <span className="ana-legend-label">{seg.label}</span>
                            <span className="ana-legend-value">{seg.value}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  <EmptyBlock
                    icon="👥"
                    title="No contact data yet"
                    sub="Import or add contacts to see your audience breakdown here."
                  />
                )}
              </div>
            </div>

            <div className="dash-grid-2">
              {/* Top campaigns */}
              <div className="card">
                <div className="dash-card-head">
                  <div>
                    <div className="dash-card-title">Top Campaigns by Open Rate</div>
                    <div className="dash-card-subtitle">Best performing sent campaigns in this period</div>
                  </div>
                </div>
                {data.top_campaigns.length > 0 ? (
                  <div className="ana-camp-list">
                    {data.top_campaigns.map((c) => (
                      <div className="ana-camp-row" key={c.id}>
                        <div className="ana-camp-main">
                          <div className="ana-camp-name">{c.name}</div>
                          <div className="ana-camp-meta">
                            {c.sent} sent · {c.opened} opened · {c.clicked} clicked
                          </div>
                          <div className="progress" style={{ marginTop: 6 }}>
                            <div
                              className="progress-fill green"
                              style={{ width: `${Math.max(0, Math.min(100, c.open_rate))}%` }}
                            ></div>
                          </div>
                        </div>
                        <div className="ana-camp-rate">
                          <div className="ana-camp-open">{c.open_rate}%</div>
                          <div className="ana-camp-click">{c.click_rate}% click</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyBlock
                    icon="🏆"
                    title="No campaign analytics available yet"
                    sub="Send a campaign in this period to see it ranked here."
                  />
                )}
              </div>

              {/* Heatmap */}
              <div className="card">
                <div className="dash-card-head">
                  <div>
                    <div className="dash-card-title">Engagement Heatmap</div>
                    <div className="dash-card-subtitle">
                      Opens by day of week and hour of day
                    </div>
                  </div>
                </div>
                {heatmapHasData ? (
                  <>
                    <div className="ana-heatmap">
                      <div className="ana-hm-head">
                        <span className="ana-hm-corner"></span>
                        {HOUR_STEPS.map((h) => (
                          <span className="ana-hm-hour" key={h}>
                            {h === 0 ? '12a' : h === 12 ? '12p' : h === 23 ? '11p' : `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`}
                          </span>
                        ))}
                      </div>
                      {DAY_LABELS.map((dayLabel, day) => (
                        <div className="ana-hm-row" key={dayLabel}>
                          <span className="ana-hm-day">{dayLabel}</span>
                          <div className="ana-hm-cells">
                            {Array.from({ length: 24 }, (_, hour) => {
                              const cell = heatCells.get(`${day}|${hour}`)
                              const opens = cell?.opens || 0
                              const clicks = cell?.clicks || 0
                              const intensity = heatMax > 0 ? opens / heatMax : 0
                              const bg =
                                opens > 0
                                  ? `rgba(37, 99, 235, ${0.12 + 0.88 * intensity})`
                                  : '#F1F5F9'
                              return (
                                <div
                                  key={hour}
                                  className="ana-hm-cell"
                                  style={{ background: bg }}
                                  title={
                                    opens + clicks > 0
                                      ? `${dayLabel} ${hour}:00 — ${opens} open${opens === 1 ? '' : 's'}, ${clicks} click${clicks === 1 ? '' : 's'}`
                                      : `${dayLabel} ${hour}:00 — no opens`
                                  }
                                ></div>
                              )
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="ana-hm-foot">
                      <span className="ana-hm-note">
                        {data.heatmap_total} open{data.heatmap_total === 1 ? '' : 's'} / click{data.heatmap_total === 1 ? '' : 's'} across the period
                      </span>
                      <div className="ana-hm-scale">
                        <span>Less</span>
                        {[0, 1, 2, 3].map((i) => (
                          <span
                            key={i}
                            className="ana-hm-swatch"
                            style={{ background: `rgba(37, 99, 235, ${0.12 + (i / 3) * 0.88})` }}
                          ></span>
                        ))}
                        <span>More</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <EmptyBlock
                    icon="🗺"
                    title="No engagement activity yet"
                    sub="Opens and clicks will light up this heatmap as recipients engage."
                  />
                )}
              </div>
            </div>

            {/* Sequence analytics */}
            <div className="card" style={{ marginTop: 16 }}>
              <div className="dash-card-head">
                <div>
                  <div className="dash-card-title">Sequence Analytics</div>
                  <div className="dash-card-subtitle">
                    {data.sequences_total > 0
                      ? `${data.sequences_total} sequences · enrollments, sends and branch engagement`
                      : 'Email drip automation performance'}
                  </div>
                </div>
              </div>
              {data.sequences.length > 0 ? (
                <div className="table-wrap seq-table" style={{ border: 'none', borderRadius: 10 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Sequence</th>
                        <th>Status</th>
                        <th>Enrolled</th>
                        <th>Sent</th>
                        <th>Opened</th>
                        <th>Clicked</th>
                        <th>Completed</th>
                        <th>Pending</th>
                        <th>Open Rate</th>
                        <th>Click Rate</th>
                        <th>Branch Sends</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sequences.map((s) => (
                        <tr key={s.id}>
                          <td>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                            <div className="td-sub">{s.failed} failed sends</div>
                          </td>
                          <td>
                            <span className={`tag ${s.status === 'active' ? 'tag-client' : s.status === 'completed' ? 'tag-oem' : 'tag-draft'}`}>
                              {s.status}
                            </span>
                          </td>
                          <td>{s.enrolled}</td>
                          <td>{s.sent}</td>
                          <td>{s.opened}</td>
                          <td>{s.clicked}</td>
                          <td>{s.completed}</td>
                          <td>{s.pending}</td>
                          <td style={{ fontWeight: 700, color: 'var(--green)' }}>{s.open_rate}%</td>
                          <td style={{ fontWeight: 600, color: 'var(--accent)' }}>{s.click_rate}%</td>
                          <td>
                            <div className="ana-branch-sends">
                              {seqMaxSent > 0 && (
                                <div className="progress" style={{ width: 84 }}>
                                  <div
                                    className="progress-fill green"
                                    style={{ width: `${Math.max(0, Math.round((s.sent / seqMaxSent) * 100))}%` }}
                                  ></div>
                                </div>
                              )}
                              <span className="td-sub">
                                {s.branches.STARTING} starting · {s.branches.OPENED} opened · {s.branches.NOT_OPENED} not-opened
                              </span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyBlock
                  icon="⟳"
                  title="No sequence activity yet"
                  sub="Create and activate a sequence to see drip performance here."
                />
              )}
            </div>
          </>
        )
      )}
    </div>
  )
}
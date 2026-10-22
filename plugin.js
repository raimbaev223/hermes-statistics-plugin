/**
 * Statistics — a Hermes desktop plugin answering "what is Hermes doing right
 * now, and where does all that work go?"
 *
 * Architecture (no new server, no new telemetry store):
 *   this UI (renderer realm)
 *     -> host.request('shell.exec', { command })        the app's own gateway RPC
 *        -> python3 <hermes home>/desktop-plugins/statistics/collect.py
 *           -> <home>/state.db                          sessions + messages
 *           -> <home>/kanban/boards/<slug>/kanban.db    tasks, runs, events
 *           -> <home>/logs/agent.log + errors.log       per-call lines, retries
 *
 * The collector writes ONE json snapshot; this plugin reads it back through the
 * app's own file door and renders it. Refresh re-runs the collector.
 *
 * Plain ESM, loaded uncompiled: jsx()/jsxs() calls, never JSX syntax. Only
 * @hermes/plugin-sdk, react and react/jsx-runtime resolve.
 */

import {
  atom,
  Badge,
  Button,
  cn,
  Codicon,
  compactNumber,
  ErrorState,
  fmtDateTime,
  GlyphSpinner,
  host,
  PALETTE_AREA,
  PanelDetail,
  PanelEmpty,
  PanelList,
  PanelListRow,
  PanelMeta,
  PanelPill,
  PanelSectionLabel,
  ROUTES_AREA,
  ScrollArea,
  SearchField,
  SegmentedControl,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  StatusDot,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Tip,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'statistics'
const SNAPSHOT_REL = 'plugin-data/statistics/snapshot.json'
const TRACE_REL = 'plugin-data/statistics/trace'
const COLLECTOR_REL = 'desktop-plugins/statistics/collect.py'
// The collector stat()s 9 state.db files and tails logs, so it is not a cheap
// poll; the page (and the statusbar chip, deduped onto the same query) refreshes
// on this cadence while visible.
const REFRESH_MS = 30_000

// ─── data layer ──────────────────────────────────────────────────────────────

const $home = atom(null)
const $shellSession = atom(null)

// The gateway's canonical dispatcher serves `shell.exec` through the session
// authority: `{command}` alone comes back as `4001 invalid_params` — it wants
// a `session_id` too (the command then runs in that session's launch cwd;
// every path this plugin passes is absolute). Gateways older than the session
// authority take no session at all, so the bare form is the last fallback.
async function shellSessionIds() {
  const ids = []
  const cached = $shellSession.get()
  if (cached) ids.push(cached)
  try {
    const focused = host.state.focusedSessionId ? host.state.focusedSessionId.get() : null
    if (typeof focused === 'string' && focused) ids.push(focused)
  } catch {
    // host.state unavailable: fall through to the session list
  }
  if (!cached) {
    try {
      const res = await host.request('session.list', { limit: 1 }, 20_000)
      const row = res && Array.isArray(res.sessions) ? res.sessions[0] : null
      const sid = row && (row.session_id || row.id)
      if (sid) ids.push(sid)
    } catch {
      // no session store reachable: the bare form below still gets a chance
    }
  }
  ids.push(null)
  return [...new Set(ids)]
}

async function shellExec(command, timeoutMs) {
  const budget = timeoutMs || 120_000
  let lastErr = null
  for (const sid of await shellSessionIds()) {
    try {
      const params = sid ? { session_id: sid, command } : { command }
      const res = await host.request('shell.exec', params, budget)
      if (sid) $shellSession.set(sid)
      return res
    } catch (err) {
      lastErr = err
      $shellSession.set(null)
    }
  }
  throw lastErr || new Error('shell.exec failed')
}

/** The gateway process's own HERMES_HOME. `hermes serve` runs with the hermes
 *  ROOT (multi-profile hosting), so the shell is the only honest source. */
async function resolveHome() {
  const known = $home.get()
  if (known) return known

  let home = null
  try {
    const res = await shellExec('printf %s "$HERMES_HOME"', 20_000)
    const out = (res && res.stdout ? res.stdout : '').trim()
    if (out && out.indexOf('/') === 0) home = out.replace(/\/+$/, '')
  } catch {
    home = null
  }
  if (!home) {
    const root = await window.hermesDesktop?.desktopPluginsRoot?.()
    if (root) home = root.replace(/\/desktop-plugins\/?$/, '')
  }
  if (home) $home.set(home)
  return home
}

async function runCollector(args, timeoutMs) {
  const home = await resolveHome()
  if (!home) throw new Error('could not resolve the Hermes home (desktop bridge unavailable)')
  const cmd = ['python3', `${home}/${COLLECTOR_REL}`, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')
  const res = await shellExec(cmd, timeoutMs || 120_000)
  if (!res || res.code !== 0) {
    throw new Error((res && res.stderr && res.stderr.trim()) || `collector exited with code ${res ? res.code : '?'}`)
  }
  return home
}

async function readJson(path) {
  const file = await window.hermesDesktop?.readFileText?.(path)
  if (!file || !file.text) throw new Error(`not found: ${path}`)
  if (file.truncated) throw new Error(`file exceeds the preview cap: ${path}`)
  return JSON.parse(file.text)
}

async function fetchSnapshot() {
  const home = await runCollector([], 120_000)
  return readJson(`${home}/${SNAPSHOT_REL}`)
}

function fetchTrace(taskId) {
  return (async () => {
    const home = await runCollector(['--mode', 'trace', '--task', taskId], 120_000)
    return readJson(`${home}/${TRACE_REL}-${taskId}.json`)
  })()
}

/** ONE query, shared by the page and the statusbar chip (same key => deduped
 *  poll, one collector run per tick). */
function useSnapshot(enabled) {
  return useQuery({
    enabled: enabled !== false,
    queryFn: fetchSnapshot,
    queryKey: ['statistics', 'snapshot'],
    refetchInterval: enabled === false ? false : REFRESH_MS,
    retry: 0,
    staleTime: 5_000
  })
}

function useTrace(taskId) {
  return useQuery({
    enabled: Boolean(taskId),
    queryFn: () => fetchTrace(taskId),
    queryKey: ['statistics', 'trace', taskId],
    retry: 0
  })
}

// ─── formatting (SDK helpers, so numbers read like core's) ───────────────────

const compact = (v) => (v === null || v === undefined ? '—' : compactNumber(Number(v) || 0))
const exact = (v) => (v === null || v === undefined ? '—' : new Intl.NumberFormat().format(Number(v) || 0))
const pct = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${Math.round(v)}%`)
const secs = (ms) => {
  if (ms === null || ms === undefined) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
const ago = (ts) => {
  if (!ts) return '—'
  const ms = Date.now() - ts * 1000
  if (ms < 60_000) return 'just now'
  return `${secs(ms)} ago`
}

const TONE_CLASS = { bad: 'bg-destructive', good: 'bg-primary', muted: 'bg-muted-foreground/40', warn: 'bg-amber-500' }
const STATUS_TONE = {
  done: 'good', completed: 'good',
  running: 'warn', ready: 'warn', claimed: 'warn', scheduled: 'warn', rate_limited: 'warn',
  blocked: 'bad', failed: 'bad', error: 'bad', crashed: 'bad', timed_out: 'bad', spawn_failed: 'bad',
  triage: 'muted', todo: 'muted', released: 'muted'
}
const toneOf = (s) => STATUS_TONE[String(s || '').toLowerCase()] || 'muted'

// ─── primitives ──────────────────────────────────────────────────────────────

function Metric({ hint, label, sub, value, tone }) {
  return jsxs('div', {
    className: 'flex min-w-0 flex-col gap-0.5 rounded-md border border-(--ui-stroke-secondary) px-2.5 py-2',
    children: [
      jsx(Tip, {
        label: hint || label,
        children: jsx('div', {
          className: 'truncate text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground/55',
          children: label
        })
      }),
      jsx('div', {
        className: cn(
          'text-lg leading-tight font-semibold tabular-nums',
          tone === 'bad' && 'text-destructive',
          tone === 'warn' && 'text-amber-600 dark:text-amber-400',
          tone === 'good' && 'text-primary',
          !tone && 'text-foreground'
        ),
        children: value
      }),
      sub ? jsx('div', { className: 'truncate text-[0.62rem] text-muted-foreground/60', children: sub }) : null
    ]
  })
}

function Bar({ fraction }) {
  const f = Math.max(0, Math.min(1, fraction || 0))
  return jsx('div', {
    className: 'h-1.5 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary)',
    children: jsx('div', { className: 'h-full rounded-full bg-primary/70', style: { width: `${f * 100}%` } })
  })
}

function TopConsumers({ consumers, metric }) {
  const key = metric || 'llm_calls'
  const max = Math.max(1, ...consumers.map((c) => c[key] || 0))
  if (!consumers.length) return jsx('p', { className: 'text-[0.7rem] text-muted-foreground/55', children: 'No activity recorded yet.' })
  return jsx('div', {
    className: 'flex flex-col gap-2',
    children: consumers.slice(0, 12).map((c) =>
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsxs('div', {
            className: 'flex items-center justify-between gap-2 text-[0.72rem]',
            children: [
              jsxs('div', {
                className: 'flex min-w-0 items-center gap-1.5',
                children: [
                  jsx(StatusDot, { tone: c.retries || c.api_failures ? 'warn' : 'muted' }),
                  jsx('span', { className: 'truncate font-medium', children: c.agent }),
                  c.group ? jsx(PanelPill, { tone: 'muted', children: c.group }) : null
                ]
              }),
              jsxs('div', {
                className: 'flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground/70',
                children: [
                  jsx('span', { children: exact(c[key]) }),
                  jsx('span', {
                    className: 'w-16 truncate text-right text-muted-foreground/50',
                    children: c.cost_usd ? `$${c.cost_usd.toFixed(2)}` : ''
                  })
                ]
              })
            ]
          }),
          jsx(Bar, { fraction: (c[key] || 0) / max })
        ]
      }, c.agent))
  })
}

// ─── charts (plain SVG, no chart library) ────────────────────────────────────

// Series palette: the app's own hues, so the charts repaint with the theme.
const SERIES_COLORS = [
  'var(--ui-purple)',
  'var(--ui-blue)',
  'var(--ui-green)',
  'var(--ui-orange)',
  'var(--ui-cyan)',
  'var(--ui-red)',
  'var(--ui-accent)'
]
const OTHER_COLOR = 'var(--ui-text-quaternary)'

const hourStamp = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}`

const hourTime = (h) => Date.parse(`${String(h).slice(0, 13).replace(' ', 'T')}:00:00`)

/**
 * The log parser only emits hours that had calls, so a raw series jumps 18:00 →
 * 21:00 with no marker. On a line chart that reads as three flat hours, so the
 * window is rebuilt hour by hour and the holes become real zero buckets.
 */
function densifyHours(rows, cap) {
  if (rows.length < 2) return rows
  const step = 3600 * 1000
  const first = hourTime(rows[0].hour)
  const last = hourTime(rows[rows.length - 1].hour)
  if (!Number.isFinite(first) || !Number.isFinite(last) || last <= first) return rows
  const span = Math.round((last - first) / step) + 1
  if (span <= rows.length || span > (cap || 240)) return rows
  const byHour = new Map(rows.map((r) => [hourTime(r.hour), r]))
  const out = []
  for (let t = first; t <= last; t += step) {
    out.push(byHour.get(t) || { avg_latency: 0, gap: true, hour: hourStamp(new Date(t)), in: 0, llm: 0, out: 0 })
  }
  return out
}

/** Top `max` rows by value, the rest folded into one `other` slice. */
function topSegments(rows, max) {
  const live = rows.filter((r) => (r.value || 0) > 0).sort((a, b) => b.value - a.value)
  const limit = max || 6
  if (live.length <= limit) return live.map((r, i) => ({ ...r, color: r.color || SERIES_COLORS[i % SERIES_COLORS.length] }))
  const head = live.slice(0, limit - 1)
  const rest = live.slice(limit - 1).reduce((a, r) => a + r.value, 0)
  return [
    ...head.map((r, i) => ({ ...r, color: r.color || SERIES_COLORS[i % SERIES_COLORS.length] })),
    { label: 'other', value: rest, color: OTHER_COLOR }
  ]
}

function ChartCard({ children, hint, title }) {
  return jsxs('div', {
    className: 'flex min-w-0 flex-col gap-2 rounded-md border border-(--ui-stroke-secondary) px-2.5 py-2',
    children: [
      jsx(Tip, {
        label: hint || title,
        children: jsx('div', {
          className: 'text-[0.6rem] font-medium uppercase tracking-wider text-muted-foreground/55',
          children: title
        })
      }),
      children
    ]
  })
}

/**
 * Donut. Arcs are drawn as dashed strokes on one circle, so no arc maths and no
 * chart library. In-slice labels are white with a dark halo: the only way to
 * stay readable over an arbitrary series colour in both the light and dark
 * theme, where a single theme text token would flip contrast on half the ring.
 */
function Donut({ centerLabel, centerValue, labelMode, segments }) {
  const total = segments.reduce((a, s) => a + (s.value || 0), 0)
  if (!total) {
    return jsx('p', { className: 'text-[0.7rem] text-muted-foreground/55', children: 'No recorded activity.' })
  }

  const R = 62
  const SW = 26
  const C = 2 * Math.PI * R
  const GAP = segments.length > 1 ? 2.5 : 0
  let acc = 0
  const arcs = []
  const labels = []

  for (const s of segments) {
    const frac = (s.value || 0) / total
    const len = Math.max(0, frac * C - GAP)
    arcs.push(jsx('circle', {
      cx: 80,
      cy: 80,
      fill: 'none',
      r: R,
      stroke: s.color,
      strokeDasharray: `${len} ${C - len}`,
      strokeDashoffset: -acc,
      strokeWidth: SW,
      transform: 'rotate(-90 80 80)',
      children: jsx('title', { children: `${s.label}: ${exact(s.value)} · ${pct(frac * 100)}` })
    }, `arc-${s.label}`))

    // Below ~7% (or ~10% for the wider token labels) the text would spill over
    // the neighbouring arc, so the legend carries those values instead.
    const minFrac = labelMode === 'value' ? 0.1 : 0.07
    if (frac >= minFrac) {
      const mid = ((acc + (frac * C) / 2) / C) * 2 * Math.PI - Math.PI / 2
      labels.push(jsx('text', {
        dominantBaseline: 'central',
        fill: '#fff',
        style: {
          fontSize: 11,
          fontWeight: 600,
          paintOrder: 'stroke',
          stroke: 'rgba(0,0,0,0.4)',
          strokeLinejoin: 'round',
          strokeWidth: 2.6
        },
        textAnchor: 'middle',
        x: 80 + Math.cos(mid) * R,
        y: 80 + Math.sin(mid) * R,
        children: labelMode === 'value' ? compact(s.value) : pct(frac * 100)
      }, `label-${s.label}`))
    }
    acc += frac * C
  }

  return jsxs('div', {
    className: 'flex min-w-0 items-center gap-3',
    children: [
      jsxs('svg', {
        className: 'shrink-0',
        style: { height: 148, width: 148 },
        viewBox: '0 0 160 160',
        children: [
          jsx('circle', {
            cx: 80,
            cy: 80,
            fill: 'none',
            opacity: 0.3,
            r: R,
            stroke: 'var(--ui-bg-tertiary)',
            strokeWidth: SW
          }),
          ...arcs,
          ...labels,
          centerValue
            ? jsx('text', {
                style: { fill: 'var(--ui-text-primary)', fontSize: 13, fontWeight: 600 },
                textAnchor: 'middle',
                x: 80,
                y: 77,
                children: centerValue
              })
            : null,
          centerLabel
            ? jsx('text', {
                style: { fill: 'var(--ui-text-quaternary)', fontSize: 7.5, letterSpacing: '0.08em' },
                textAnchor: 'middle',
                x: 80,
                y: 91,
                children: String(centerLabel).toUpperCase()
              })
            : null
        ]
      }),
      jsx('div', {
        className: 'flex min-w-0 flex-1 flex-col gap-1',
        style: { maxWidth: 240 },
        children: segments.map((s) =>
          jsxs('div', {
            className: 'flex min-w-0 items-center gap-1.5 text-[0.66rem]',
            children: [
              jsx('span', {
                className: 'size-2 shrink-0 rounded-[2px]',
                style: { background: s.color }
              }),
              jsx('span', { className: 'min-w-0 flex-1 truncate text-muted-foreground/80', children: s.label }),
              jsx('span', { className: 'shrink-0 tabular-nums text-foreground/85', children: exact(s.value) }),
              jsx('span', {
                className: 'w-9 shrink-0 text-right tabular-nums text-muted-foreground/50',
                children: pct(((s.value || 0) / total) * 100)
              })
            ]
          }, s.label)
        )
      })
    ]
  })
}

/** Live pixel width of a node — SVG is laid out 1:1 so labels never stretch. */
function useMeasuredWidth(fallback) {
  const ref = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const read = () => setWidth(Math.round(el.getBoundingClientRect().width) || 0)
    read()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width || fallback]
}

/**
 * Multi-series line chart: thin strokes, a dot per point, dashed-free grid and
 * an axis label per ~6 buckets — the reading order is legend, shape, table.
 */
function LineChart({ formatY, labels, series, titles }) {
  const H = 148
  const P = { b: 18, l: 40, r: 10, t: 8 }
  const [ref, W] = useMeasuredWidth(560)
  const n = labels.length
  const max = Math.max(1, ...series.flatMap((s) => s.values.map((v) => v || 0)))
  const x = (i) => (n <= 1 ? P.l + (W - P.l - P.r) / 2 : P.l + (i / (n - 1)) * (W - P.l - P.r))
  const y = (v) => P.t + (1 - (v || 0) / max) * (H - P.t - P.b)
  const fmt = formatY || compact
  const titleAt = (i) => (titles && titles[i]) || labels[i]

  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const every = Math.max(1, Math.ceil(n / 6))

  return jsxs('div', {
    className: 'flex min-w-0 flex-col gap-1.5',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-3 text-[0.62rem] text-muted-foreground/70',
        children: series.map((s) =>
          jsxs('div', {
            className: 'flex items-center gap-1.5',
            children: [
              jsx('span', { className: 'h-px w-4', style: { background: s.color } }),
              jsx('span', { children: s.label })
            ]
          }, s.label)
        )
      }),
      jsx('div', {
        className: 'w-full',
        ref,
        children: jsx('svg', {
          className: 'block w-full',
          height: H,
          viewBox: `0 0 ${W} ${H}`,
          width: W,
          children: [
          ...ticks.map((t) =>
            jsxs('g', {
              children: [
                jsx('line', {
                  stroke: 'var(--ui-stroke-secondary)',
                  strokeWidth: 1,
                  x1: P.l,
                  x2: W - P.r,
                  y1: y(max * t),
                  y2: y(max * t)
                }),
                jsx('text', {
                  className: 'text-[9px]',
                  style: { fill: 'var(--ui-text-quaternary)' },
                  textAnchor: 'end',
                  x: P.l - 5,
                  y: y(max * t) + 3,
                  children: fmt(max * t)
                })
              ]
            }, `tick-${t}`)
          ),
          ...labels.map((label, i) =>
            i % every === 0 || i === n - 1
              ? jsx('text', {
                  className: 'text-[9px]',
                  style: { fill: 'var(--ui-text-quaternary)' },
                  textAnchor: i === n - 1 ? 'end' : 'middle',
                  x: x(i),
                  y: H - 5,
                  children: label
                }, `x-${label}-${i}`)
              : null
          ),
          ...series.map((s) =>
            jsxs('g', {
              children: [
                jsx('path', {
                  d: s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '),
                  fill: 'none',
                  stroke: s.color,
                  strokeLinejoin: 'round',
                  strokeWidth: 1.6
                }),
                ...s.values.map((v, i) =>
                  jsx('circle', {
                    cx: x(i),
                    cy: y(v),
                    fill: s.color,
                    r: 2.3,
                    children: jsx('title', { children: `${titleAt(i)} — ${s.label}: ${exact(v)}` })
                  }, `pt-${s.label}-${i}`)
                )
              ]
            }, `series-${s.label}`)
          )
          ]
        })
      })
    ]
  })
}

/** One horizontal 100% bar plus a legend — composition at a glance. */
function StackedBar({ segments }) {
  const total = segments.reduce((a, s) => a + (s.value || 0), 0)
  if (!total) {
    return jsx('p', { className: 'text-[0.7rem] text-muted-foreground/55', children: 'No tokens recorded.' })
  }
  return jsxs('div', {
    className: 'flex flex-col gap-2 py-1',
    children: [
      jsx('div', {
        className: 'flex h-2.5 w-full overflow-hidden rounded-full bg-(--ui-bg-tertiary)',
        children: segments.map((s) =>
          jsx('div', {
            className: 'h-full',
            style: { background: s.color, width: `${((s.value || 0) / total) * 100}%` },
            title: `${s.label}: ${exact(s.value)} · ${pct(((s.value || 0) / total) * 100)}`
          }, s.label)
        )
      }),
      jsxs('div', {
        className: 'flex flex-wrap gap-x-4 gap-y-1',
        children: segments.map((s) =>
          jsxs('div', {
            className: 'flex items-center gap-1.5 text-[0.66rem]',
            children: [
              jsx('span', { className: 'size-2 shrink-0 rounded-[2px]', style: { background: s.color } }),
              jsx('span', { className: 'text-muted-foreground/80', children: s.label }),
              jsx('span', { className: 'tabular-nums text-foreground/85', children: compact(s.value) }),
              jsx('span', { className: 'tabular-nums text-muted-foreground/50', children: pct(((s.value || 0) / total) * 100) })
            ]
          }, s.label)
        )
      })
    ]
  })
}

function Th({ align, children }) {
  return jsx('th', {
    className: cn('py-1 pr-2 font-medium', align === 'right' ? 'text-right' : 'text-left'),
    children
  })
}

function THead({ cols }) {
  return jsx('thead', {
    className: 'sticky top-0 z-10 bg-background',
    children: jsx('tr', {
      className: 'text-[0.6rem] uppercase tracking-wider text-muted-foreground/50',
      children: cols.map((c, i) => jsx(Th, { align: c[1], children: c[0] }, `${c[0]}-${i}`))
    })
  })
}

function Td({ align, children, className }) {
  return jsx('td', {
    className: cn('py-1 pr-2', align === 'right' && 'text-right tabular-nums', className),
    children
  })
}

// ─── Overview ────────────────────────────────────────────────────────────────

function Overview({ onOpenAgent, snap }) {
  const t = snap.totals
  const active = snap.profiles.filter((p) => p.active_sessions > 0)
  return jsxs('div', {
    className: 'flex flex-col gap-4',
    children: [
      jsx('div', {
        className: 'grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4',
        children: [
          jsx(Metric, {
            label: 'Active agents', value: String(active.length),
            sub: `${snap.totals.profiles} agents with history`, tone: active.length ? 'good' : undefined,
            hint: 'Profiles with at least one session whose ended_at is still NULL.'
          }, 'agents'),
          jsx(Metric, {
            label: 'LLM requests', value: exact(t.llm_calls), sub: `${compact(t.cache_read)} cache-read tokens`,
            hint: 'Sum of sessions.api_call_count across all profiles — real API calls, retries included.'
          }, 'llm'),
          jsx(Metric, {
            label: 'Tool calls', value: compact(t.tool_calls), sub: `${compact(t.sessions)} sessions`,
            hint: 'Sum of sessions.tool_call_count.'
          }, 'tools'),
          jsx(Metric, {
            label: 'Input / Output', value: `${compact(t.input)} / ${compact(t.output)}`, sub: 'tokens',
            hint: 'Sum of sessions.input_tokens and sessions.output_tokens.'
          }, 'tokens'),
          jsx(Metric, {
            label: 'Tasks', value: String(t.tasks), sub: `${t.boards} boards`,
            hint: 'Kanban tasks across every board database on disk.'
          }, 'tasks'),
          jsx(Metric, {
            label: 'Errors', value: compact(t.api_failures), tone: t.api_failures ? 'bad' : undefined,
            sub: `${compact(t.tool_errors)} tool errors`,
            hint: 'ERROR lines plus "Tool ... returned error" lines in each profile\'s logs/errors.log.'
          }, 'errors'),
          jsx(Metric, {
            label: 'Retries', value: compact(t.retries), tone: t.retries ? 'warn' : undefined,
            sub: 'reconnects / rate limits',
            hint: 'Logged retries (connection attempts, Telegram reconnects). Retries happening INSIDE one API call are not logged.'
          }, 'retries'),
          jsx(Metric, {
            label: 'Messages', value: compact(t.messages), sub: 'stored rows',
            hint: 'Sum of sessions.message_count.'
          }, 'messages'),
        ]
      }),
      jsxs('div', {
        className: 'flex flex-col gap-2',
        children: [
          jsx(PanelSectionLabel, { children: 'Top consumers — LLM requests' }),
          jsx(TopConsumers, { consumers: snap.consumers, metric: 'llm_calls' })
        ]
      }),
      active.length
        ? jsxs('div', {
            className: 'flex flex-col gap-2',
            children: [
              jsx(PanelSectionLabel, { children: 'Active now' }),
              jsx('div', {
                className: 'flex flex-col gap-1',
                children: active.map((p) =>
                  jsxs('button', {
                    className: 'flex items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-[0.72rem] hover:bg-(--chrome-action-hover)',
                    onClick: () => onOpenAgent(p.name),
                    type: 'button',
                    children: [
                      jsxs('span', {
                        className: 'flex min-w-0 items-center gap-1.5',
                        children: [
                          jsx(StatusDot, { tone: 'warn' }),
                          jsx('span', { className: 'font-medium', children: p.name }),
                          jsx('span', { className: 'truncate text-muted-foreground/60', children: p.description || '' })
                        ]
                      }),
                      jsxs('span', {
                        className: 'flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground/70',
                        children: [
                          jsx('span', { children: `${p.active_sessions} open` }),
                          jsx('span', { children: ago(p.last_activity) })
                        ]
                      })
                    ]
                  }, p.name))
              })
            ]
          })
        : null,
      jsxs('div', {
        className: 'flex flex-col gap-1.5',
        children: [
          jsx(PanelSectionLabel, { children: 'Recent errors & retries' }),
          snap.recent_errors.length
            ? jsx('div', {
                className: 'flex flex-col gap-0.5',
                children: snap.recent_errors.slice(0, 15).map((e, i) =>
                  jsxs('div', {
                    className: 'flex items-start gap-2 text-[0.66rem]',
                    children: [
                      jsx(PanelPill, { tone: e.kind === 'conn_retry' ? 'warn' : 'bad', children: e.kind }),
                      jsx('span', { className: 'w-20 shrink-0 text-muted-foreground/60', children: e.profile }),
                      jsx('span', { className: 'min-w-0 flex-1 truncate text-muted-foreground/80', children: e.line })
                    ]
                  }, i))
              })
            : jsx('p', { className: 'text-[0.7rem] text-muted-foreground/55', children: 'No errors in the retained log window.' })
        ]
      })
    ]
  })
}

// ─── Agents ──────────────────────────────────────────────────────────────────

function AgentDetail({ profile }) {
  const sessions = profile.recent || []
  return jsxs(PanelDetail, {
    children: [
      jsxs('div', {
        className: 'flex flex-col gap-1',
        children: [
          jsxs('div', {
            className: 'flex items-center gap-2',
            children: [
              jsx('span', { className: 'text-sm font-semibold', children: profile.name }, 'name'),
              profile.group ? jsx(PanelPill, { tone: 'good', children: profile.group }, 'group') : null
            ]
          }, 'title'),
          profile.description
            ? jsx('p', { className: 'text-[0.7rem] text-muted-foreground/70', children: profile.description }, 'desc')
            : null
        ]
      }, 'head'),
      jsx(PanelMeta, {
        rows: [
          { label: 'LLM req', value: exact(profile.llm_calls) },
          { label: 'Tool calls', value: exact(profile.tool_calls) },
          { label: 'Input', value: exact(profile.input) },
          { label: 'Output', value: exact(profile.output) },
          { label: 'Cache read', value: exact(profile.cache_read) },
          { label: 'Sessions', value: `${profile.sessions} (${profile.active_sessions} open)` },
          { label: 'Errors', value: exact(profile.api_failures) },
          { label: 'Tool errors', value: exact(profile.tool_errors) },
          { label: 'Retries', value: exact(profile.retries) },
          { label: 'Last active', value: ago(profile.last_activity) },
          { label: 'Home', value: profile.home }
        ].map((r) => ({ ...r, key: r.label }))
      }, 'meta'),
      profile.by_source && profile.by_source.length
        ? jsxs('div', {
            className: 'flex flex-col gap-1.5',
            children: [
              jsx(PanelSectionLabel, { children: 'By source' }),
              jsx('table', {
                className: 'w-full border-collapse text-[0.7rem]',
                children: [
                  jsx(THead, { cols: [['Source'], ['LLM req', 'right'], ['Tool calls', 'right'], ['Sessions', 'right'], ['Tokens', 'right']] }, 'head'),
                  jsx('tbody', {
                    children: profile.by_source.map((s) =>
                      jsxs('tr', {
                        className: 'border-t border-(--ui-stroke-secondary)/40',
                        children: [
                          jsx(Td, { children: s.source || '(unknown)' }, 'source'),
                          jsx(Td, { align: 'right', children: exact(s.llm_calls) }, 'calls'),
                          jsx(Td, { align: 'right', children: exact(s.tool_calls) }, 'tools'),
                          jsx(Td, { align: 'right', children: exact(s.sessions) }, 'sessions'),
                          jsx(Td, { align: 'right', children: exact((s.input || 0) + (s.output || 0)) }, 'tokens')
                        ]
                      }, s.source))
                  }, 'body')
                ]
              })
            ]
          }, 'by-source')
        : null,
      profile.by_model && profile.by_model.length
        ? jsxs('div', {
            className: 'flex flex-col gap-1.5',
            children: [
              jsx(PanelSectionLabel, { children: 'By model' }),
              jsx('table', {
                className: 'w-full border-collapse text-[0.7rem]',
                children: [
                  jsx(THead, { cols: [['Model'], ['LLM req', 'right'], ['Input', 'right'], ['Output', 'right']] }, 'head'),
                  jsx('tbody', {
                    children: profile.by_model.map((m) =>
                      jsxs('tr', {
                        className: 'border-t border-(--ui-stroke-secondary)/40',
                        children: [
                          jsx(Td, { className: 'truncate', children: m.model }, 'model'),
                          jsx(Td, { align: 'right', children: exact(m.llm_calls) }, 'calls'),
                          jsx(Td, { align: 'right', children: exact(m.input) }, 'in'),
                          jsx(Td, { align: 'right', children: exact(m.output) }, 'out')
                        ]
                      }, m.model))
                  }, 'body')
                ]
              })
            ]
          }, 'by-model')
        : null,
      jsxs('div', {
        className: 'flex flex-col gap-1.5',
        children: [
          jsx(PanelSectionLabel, { children: `Recent sessions (${sessions.length})` }),
          jsx('div', {
            className: 'flex flex-col gap-1',
            children: sessions.slice(0, 40).map((s) =>
              jsxs('div', {
                className: 'flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-(--chrome-action-hover)',
                children: [
                  jsxs('span', {
                    className: 'flex min-w-0 flex-col',
                    children: [
                      jsx('span', { className: 'truncate text-[0.72rem]', children: s.title || s.id }),
                      jsx('span', {
                        className: 'truncate text-[0.62rem] text-muted-foreground/55',
                        children: `${s.source || '?'} · ${ago(s.last_activity_at || s.started_at)}${s.ended_at ? '' : ' · open'}`
                      })
                    ]
                  }),
                  jsxs('span', {
                    className: 'flex shrink-0 items-center gap-2 tabular-nums text-[0.65rem] text-muted-foreground/70',
                    children: [
                      jsx('span', { children: `${exact(s.api_call_count)} calls` }),
                      jsx('span', { children: `${exact(s.tool_call_count)} tools` })
                    ]
                  })
                ]
              }, s.id))
          })
        ]
      }, 'recent')
    ]
  })
}

function AgentsTab({ onSelect, selected, snap }) {
  return jsxs('div', {
    className: 'flex min-h-0 flex-1 gap-4',
    children: [
      jsx(PanelList, {
        children: snap.consumers.map((c) =>
          jsx(PanelListRow, {
            active: selected === c.agent,
            dotClassName: TONE_CLASS[c.retries || c.api_failures ? 'warn' : 'good'],
            meta: `${compact(c.llm_calls)} calls`,
            onSelect: () => onSelect(c.agent),
            rowKey: c.agent,
            title: c.agent
          }, c.agent))
      }),
      jsx('div', {
        className: 'flex min-h-0 min-w-0 flex-1 flex-col',
        children: selected
          ? jsx(AgentDetail, { profile: snap.profiles.find((p) => p.name === selected) || { name: selected, recent: [] } })
          : jsx(PanelEmpty, {
              description: 'The left list holds every agent with recorded activity — click one.',
              icon: 'hubot',
              title: 'Select an agent'
            })
      })
    ]
  })
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

function TasksTab({ onOpenTrace, snap }) {
  const [status, setStatus] = useState('all')
  const [agent, setAgent] = useState('all')
  const [text, setText] = useState('')
  const [onlyLinked, setOnlyLinked] = useState(false)

  const agentOptions = useMemo(
    () => ['all', ...Array.from(new Set(snap.tasks.map((t) => t.profile || '(none)'))).slice(0, 3)],
    [snap]
  )
  const statusOptions = useMemo(
    () => ['all', ...Array.from(new Set(snap.tasks.map((t) => t.status))).slice(0, 3)],
    [snap]
  )

  const rows = snap.tasks.filter((t) => {
    if (status !== 'all' && t.status !== status) return false
    if (agent !== 'all' && (t.profile || '(none)') !== agent) return false
    if (onlyLinked && !t.session) return false
    if (text && `${t.title} ${t.id}`.toLowerCase().indexOf(text.toLowerCase()) < 0) return false
    return true
  })

  return jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(SearchField, { onChange: setText, placeholder: 'Filter by title or id…', value: text }),
          jsx(SegmentedControl, {
            onChange: setStatus,
            options: statusOptions.map((s) => ({ id: s, label: s })),
            value: status
          }),
          jsx(SegmentedControl, {
            onChange: setAgent,
            options: agentOptions.map((a) => ({ id: a, label: a })),
            value: agent
          }),
          jsxs('label', {
            className: 'flex items-center gap-1.5 text-[0.68rem] text-muted-foreground/70',
            children: [
              jsx(Switch, { checked: onlyLinked, onCheckedChange: setOnlyLinked, size: 'xs' }),
              jsx('span', { children: 'only tasks with usage' })
            ]
          }, 'agents'),
        ]
      }),
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto overscroll-contain',
        children: jsxs('table', {
          className: 'w-full border-collapse text-[0.7rem]',
          children: [
            jsx(THead, {
              cols: [
                ['Task'], ['Agent'], ['Status'],
                ['LLM', 'right'], ['Tools', 'right'], ['In', 'right'], ['Out', 'right'],
                ['Runs', 'right'], ['Duration', 'right'], ['Finished']
              ]
            }),
            jsx('tbody', {
              children: rows.map((t) => {
                const dur = t.run_started_at && t.run_ended_at ? (t.run_ended_at - t.run_started_at) * 1000 : null
                return jsxs('tr', {
                  className: 'cursor-pointer border-t border-(--ui-stroke-secondary)/40 hover:bg-(--chrome-action-hover)',
                  onClick: () => onOpenTrace(t.id),
                  children: [
                    jsx('td', {
                      className: 'max-w-[22rem] py-1 pr-2',
                      children: jsxs('span', {
                        className: 'flex min-w-0 flex-col',
                        children: [
                          jsx('span', { className: 'truncate', children: t.title }),
                          jsx('span', {
                            className: 'truncate text-[0.6rem] text-muted-foreground/50',
                            children: `${t.id} · ${t.board}${t.branch_name ? ` · ${t.branch_name}` : ''}`
                          })
                        ]
                      })
                    }),
                    jsx(Td, { className: 'text-muted-foreground/80', children: t.profile || '—' }),
                    jsx('td', {
                      className: 'py-1 pr-2',
                      children: jsx(PanelPill, { tone: toneOf(t.status), children: t.status })
                    }),
                    jsx(Td, { align: 'right', children: t.api_call_count != null ? compact(t.api_call_count) : '—' }),
                    jsx(Td, { align: 'right', children: t.tool_call_count != null ? compact(t.tool_call_count) : '—' }),
                    jsx(Td, { align: 'right', children: t.input != null ? compact(t.input) : '—' }),
                    jsx(Td, { align: 'right', children: t.output != null ? compact(t.output) : '—' }),
                    jsx(Td, { align: 'right', className: 'text-muted-foreground/70', children: t.run_count }),
                    jsx(Td, { align: 'right', className: 'text-muted-foreground/70', children: secs(dur) }),
                    jsx(Td, { className: 'text-muted-foreground/60', children: ago(t.completed_at || t.run_ended_at) })
                  ]
                }, t.id)
              })
            })
          ]
        })
      }),
      jsx('p', {
        className: 'text-[0.62rem] text-muted-foreground/50',
        children: `${rows.length} of ${snap.tasks.length} tasks. LLM/Tools/In/Out come from the task's worker session (task_runs.metadata.worker_session_id); "—" means the task recorded none. Click a row for its execution trace.`
      })
    ]
  })
}

// ─── Execution trace ─────────────────────────────────────────────────────────

function TraceEvent({ e }) {
  const bad = e.status === 'error'
  const glyph = e.kind === 'llm' ? 'sparkle' : e.kind === 'tool' ? 'tools' : 'account'
  return jsxs('div', {
    className: cn(
      'flex items-start gap-2 rounded px-1.5 py-1 text-[0.7rem]',
      e.kind === 'tool' && 'ml-5',
      bad && 'bg-destructive/5'
    ),
    children: [
      jsx('span', { className: 'w-8 shrink-0 pt-px text-right tabular-nums text-muted-foreground/40', children: e.i }),
      jsx(Codicon, {
        className: bad ? 'pt-0.5 text-destructive' : 'pt-0.5 text-muted-foreground/50',
        name: glyph,
        size: '0.75rem'
      }),
      jsxs('span', {
        className: 'flex min-w-0 flex-1 flex-col',
        children: [
          jsxs('span', {
            className: 'flex min-w-0 items-center gap-2',
            children: [
              jsx('span', { className: cn('truncate font-medium', bad && 'text-destructive'), children: e.step || e.tool || e.kind }),
              e.duration_s != null ? jsx('span', { className: 'shrink-0 tabular-nums text-muted-foreground/50', children: `${e.duration_s}s` }) : null,
              e.result_chars != null ? jsx('span', { className: 'shrink-0 tabular-nums text-muted-foreground/40', children: `${compact(e.result_chars)} chars` }) : null,
              e.finish_reason ? jsx(PanelPill, { tone: e.finish_reason === 'tool_calls' ? 'muted' : 'good', children: e.finish_reason }) : null,
              e.ts ? jsx('span', { className: 'ml-auto shrink-0 text-muted-foreground/40', children: fmtDateTime.format(e.ts * 1000) }) : null
            ]
          }),
          e.kind === 'llm' && e.tools_in_step && e.tools_in_step.length
            ? jsx('span', { className: 'truncate text-[0.62rem] text-muted-foreground/55', children: `→ ${e.tools_in_step.join(', ')}` })
            : null,
          e.args ? jsx('span', { className: 'truncate font-mono text-[0.6rem] text-muted-foreground/50', children: e.args }) : null,
          e.error ? jsx('span', { className: 'truncate text-[0.6rem] text-destructive/80', children: e.error }) : null,
          e.kind !== 'tool' && e.preview ? jsx('span', { className: 'truncate text-[0.62rem] text-muted-foreground/45', children: e.preview }) : null
        ]
      })
    ]
  })
}

function TraceTab({ snap, taskId }) {
  const { data: trace, error, isLoading } = useTrace(taskId)
  const [kind, setKind] = useState('all')

  if (!taskId) {
    return jsx(PanelEmpty, {
      description: 'Open a task from the Tasks tab. A trace is the worker session\'s real step sequence: LLM step, the tools it called, and what came back.',
      icon: 'list-tree',
      title: 'No task selected'
    })
  }

  const events = ((trace && trace.events) || []).filter((e) => kind === 'all' || e.kind === kind)

  return jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(SegmentedControl, {
            onChange: setKind,
            options: [
              { id: 'all', label: 'all' },
              { id: 'llm', label: 'LLM' },
              { id: 'tool', label: 'tools' },
              { id: 'user', label: 'user' }
            ],
            value: kind
          }),
          trace && trace.reconciliation
            ? jsx(Badge, {
                variant: 'outline',
                children: `${trace.reconciliation.session_api_call_counter} API calls recorded · ${trace.reconciliation.steps_with_tool_calls} visible as steps`
              })
            : null,
          jsx('span', { className: 'text-[0.65rem] text-muted-foreground/60', children: `task ${taskId}` })
        ]
      }),
      trace && trace.task
        ? jsx(PanelMeta, {
            rows: [
              { label: 'Task', value: trace.task.title },
              { label: 'Agent', value: trace.task.profile || '—' },
              { label: 'Status', value: jsx(PanelPill, { tone: toneOf(trace.task.status), children: trace.task.status }) },
              { label: 'Session', value: (trace.session && trace.session.id) || 'not recorded' },
              { label: 'Model', value: (trace.session && trace.session.model) || '—' },
              { label: 'Steps', value: `${trace.step_count} — ${trace.llm_count} LLM · ${trace.tool_count} tools · ${trace.errors} errors` },
              { label: 'PR', value: trace.task.pr || '—' },
              { label: 'Branch', value: trace.task.branch_name || '—' }
            ]
          })
        : null,
      isLoading
        ? jsxs('div', {
            className: 'flex items-center gap-2 text-[0.72rem] text-muted-foreground/70',
            children: [jsx(GlyphSpinner, {}), 'building trace…']
          })
        : error
          ? jsx(ErrorState, { description: error.message, title: 'Trace failed' })
          : jsxs('div', {
              className: 'flex min-h-0 flex-1 flex-col',
              children: [
                jsx(ScrollArea, {
                  className: 'min-h-0 flex-1',
                  children: jsx('div', {
                    className: 'flex flex-col gap-0.5 pr-2',
                    children: events.map((e) => jsx(TraceEvent, { e }, e.i))
                  })
                }),
                trace && trace.error
                  ? jsx('p', { className: 'pt-2 text-[0.65rem] text-amber-600 dark:text-amber-400', children: trace.error })
                  : null,
                trace && trace.llm_source
                  ? jsx('p', { className: 'pt-2 text-[0.62rem] text-muted-foreground/50', children: `LLM steps: ${trace.llm_source}` })
                  : null
              ]
            })
    ]
  })
}

// ─── Usage ───────────────────────────────────────────────────────────────────

function UsageTab({ snap }) {
  const [group, setGroup] = useState('agent')
  const consumers = snap.consumers
  const total = consumers.reduce((a, x) => a + (x.llm_calls || 0), 0) || 1

  const models = useMemo(() => {
    const merged = new Map()
    for (const p of snap.profiles) {
      for (const m of p.by_model || []) {
        const cur = merged.get(m.model) || { model: m.model, llm_calls: 0, input: 0, output: 0, cache_read: 0, cost: 0, agents: new Set() }
        cur.llm_calls += m.llm_calls || 0
        cur.input += m.input || 0
        cur.output += m.output || 0
        cur.cache_read += m.cache_read || 0
        cur.cost += m.cost || 0
        cur.agents.add(p.name)
        merged.set(m.model, cur)
      }
    }
    return [...merged.values()].sort((a, b) => b.llm_calls - a.llm_calls)
  }, [snap])

  return jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col gap-4',
    children: [
      jsx(SegmentedControl, {
        onChange: setGroup,
        options: [
          { id: 'agent', label: 'by agent' },
          { id: 'model', label: 'by model' }
        ],
        value: group
      }),
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto',
        children: group === 'agent'
          ? jsxs('table', {
              className: 'w-full border-collapse text-[0.7rem]',
              children: [
                jsx(THead, {
                  cols: [
                    ['Agent'], ['LLM req', 'right'], ['Share', 'right'], ['Input', 'right'],
                    ['Output', 'right'], ['Cache read', 'right'], ['Tools', 'right'],
                    ['Retries', 'right'], ['Cost', 'right']
                  ]
                }),
                jsx('tbody', {
                  children: consumers.map((x) =>
                    jsxs('tr', {
                      className: 'border-t border-(--ui-stroke-secondary)/40',
                      children: [
                        jsx(Td, { className: 'font-medium', children: x.agent }),
                        jsx(Td, { align: 'right', children: exact(x.llm_calls) }),
                        jsx(Td, { align: 'right', className: 'text-muted-foreground/60', children: pct((x.llm_calls / total) * 100) }),
                        jsx(Td, { align: 'right', children: exact(x.input) }),
                        jsx(Td, { align: 'right', children: exact(x.output) }),
                        jsx(Td, { align: 'right', className: 'text-muted-foreground/70', children: exact(x.cache_read) }),
                        jsx(Td, { align: 'right', children: exact(x.tool_calls) }),
                        jsx(Td, { align: 'right', className: x.retries ? 'text-amber-600 dark:text-amber-400' : undefined, children: exact(x.retries) }),
                        jsx(Td, { align: 'right', className: 'text-muted-foreground/60', children: x.cost_usd ? `$${x.cost_usd.toFixed(2)}` : '—' })
                      ]
                    }, x.agent))
                })
              ]
            })
          : models.length
            ? jsxs('table', {
                className: 'w-full border-collapse text-[0.7rem]',
                children: [
                  jsx(THead, {
                    cols: [['Model'], ['LLM req', 'right'], ['Input', 'right'], ['Output', 'right'], ['Cache read', 'right'], ['Agents']]
                  }),
                  jsx('tbody', {
                    children: models.map((x) =>
                      jsxs('tr', {
                        className: 'border-t border-(--ui-stroke-secondary)/40',
                        children: [
                          jsx(Td, { className: 'font-medium', children: x.model }),
                          jsx(Td, { align: 'right', children: exact(x.llm_calls) }),
                          jsx(Td, { align: 'right', children: exact(x.input) }),
                          jsx(Td, { align: 'right', children: exact(x.output) }),
                          jsx(Td, { align: 'right', className: 'text-muted-foreground/70', children: exact(x.cache_read) }),
                          jsx(Td, { className: 'text-muted-foreground/70', children: [...x.agents].join(', ') })
                        ]
                      }, x.model))
                  })
                ]
              })
            : jsx(PanelEmpty, { description: 'No session_model_usage rows recorded yet.', icon: 'graph', title: 'No model usage' })
      }),
      jsx('p', {
        className: 'text-[0.62rem] text-muted-foreground/50',
        children: 'Per-agent and per-model totals come from sessions and session_model_usage — the same counters the app\'s own Analytics page reads. Cost stays "—" when the provider reports no pricing.'
      })
    ]
  })
}

// ─── Activity ────────────────────────────────────────────────────────────────

function ActivityTab({ snap }) {
  const [period, setPeriod] = useState('24')
  // The selector is a TIME window anchored on the newest bucket (not a slice of
  // the last N buckets: the log parser skips empty hours, so 24 buckets can span
  // three weeks). 'all' keeps everything the retained logs hold.
  const all = snap.timeline
  const newest = all.length ? hourTime(all[all.length - 1].hour) : NaN
  const windowHours = Number(period)
  const sparse =
    period === '200' || !Number.isFinite(newest)
      ? all
      : all.filter((b) => {
          const t = hourTime(b.hour)
          return Number.isFinite(t) && t <= newest && newest - t <= (windowHours - 1) * 3600 * 1000 + 1
        })
  const series = densifyHours(sparse, windowHours + 2)

  if (!sparse.length) {
    return jsx(PanelEmpty, {
      description: 'The hourly series is parsed from API-call lines in each profile\'s logs/agent.log; the retained window holds none.',
      icon: 'pulse',
      title: 'No activity data'
    })
  }

  const totals = snap.totals || {}
  const consumers = snap.consumers || []

  const requestSegments = topSegments(consumers.map((c) => ({ label: c.agent, value: c.llm_calls || 0 })))
  const tokenSegments = topSegments(consumers.map((c) => ({ label: c.agent, value: (c.input || 0) + (c.output || 0) })))
  const requestTotal = requestSegments.reduce((a, s) => a + s.value, 0)
  const tokenTotal = tokenSegments.reduce((a, s) => a + s.value, 0)

  const labels = series.map((b) => `${b.hour.slice(-2)}:00`)
  const titles = series.map((b) => `${b.hour}:00`)

  return jsxs('div', {
    className: 'flex min-h-0 flex-1 flex-col gap-3',
    children: [
      jsxs('div', {
        className: 'flex flex-wrap items-center gap-2',
        children: [
          jsx(SegmentedControl, {
            onChange: setPeriod,
            options: [
              { id: '6', label: '6h' },
              { id: '24', label: '24h' },
              { id: '72', label: '72h' },
              { id: '200', label: 'all' }
            ],
            value: period
          }),
          jsx('span', {
            className: 'text-[0.65rem] text-muted-foreground/50',
            children: `${sparse.length} hourly buckets · ${exact(sparse.reduce((a, b) => a + b.llm, 0))} logged calls`
          }, 'agents'),
        ]
      }),
      jsx('div', {
        className: 'min-h-0 flex-1 overflow-y-auto pr-1',
        children: jsxs('div', {
          className: 'flex flex-col gap-3',
          children: [
            jsxs('div', {
              className: 'grid grid-cols-2 gap-3',
              children: [
                jsx(ChartCard, {
                  hint: 'Share of every LLM request each profile made, over the whole snapshot.',
                  title: 'LLM requests by agent',
                  children: jsx(Donut, {
                    centerLabel: 'requests',
                    centerValue: compact(requestTotal),
                    segments: requestSegments
                  })
                }),
                jsx(ChartCard, {
                  hint: 'Input + output tokens per profile. Cache reads are shown apart — they are re-sent context, not fresh work.',
                  title: 'Tokens by agent',
                  children: jsx(Donut, {
                    centerLabel: 'tokens',
                    centerValue: compact(tokenTotal),
                    labelMode: 'value',
                    segments: tokenSegments
                  })
                })
              ]
            }),
            jsx(ChartCard, {
              hint: 'API-call lines per hour from the profile logs — the same series as the table below.',
              title: 'LLM calls per hour',
              children: jsx(LineChart, {
                labels,
                series: [{ color: SERIES_COLORS[1], label: 'LLM calls', values: series.map((b) => b.llm) }],
                titles
              })
            }),
            jsx(ChartCard, {
              hint: 'Tokens sent in (prompt) and written out (completion) per hour, from the same log lines.',
              title: 'Tokens per hour',
              children: jsx(LineChart, {
                labels,
                series: [
                  { color: SERIES_COLORS[1], label: 'input', values: series.map((b) => b.in) },
                  { color: SERIES_COLORS[2], label: 'output', values: series.map((b) => b.out) }
                ],
                titles
              })
            }),
            jsx(ChartCard, {
              hint: 'All-time token mix. Cache reads dominate because every turn re-sends the cached prompt prefix.',
              title: 'Token mix — cache read / input / output',
              children: jsx(StackedBar, {
                segments: [
                  { color: SERIES_COLORS[0], label: 'cache read', value: totals.cache_read || 0 },
                  { color: SERIES_COLORS[1], label: 'input', value: totals.input || 0 },
                  { color: SERIES_COLORS[2], label: 'output', value: totals.output || 0 }
                ]
              })
            }),
            jsxs('table', {
              className: 'w-full border-collapse text-[0.68rem]',
              children: [
                jsx(THead, { cols: [['Hour'], ['LLM calls', 'right'], ['Input tok', 'right'], ['Output tok', 'right'], ['Avg latency', 'right']] }),
                jsx('tbody', {
                  children: sparse.slice().reverse().slice(0, 40).map((b) =>
                    jsxs('tr', {
                      className: 'border-t border-(--ui-stroke-secondary)/40',
                      children: [
                        jsx(Td, { className: 'text-muted-foreground/80', children: b.hour }),
                        jsx(Td, { align: 'right', children: exact(b.llm) }),
                        jsx(Td, { align: 'right', children: exact(b.in) }),
                        jsx(Td, { align: 'right', children: exact(b.out) }),
                        jsx(Td, { align: 'right', className: 'text-muted-foreground/70', children: `${b.avg_latency}s` })
                      ]
                    }, b.hour))
                })
              ]
            }),
            jsx('p', {
              className: 'text-[0.62rem] text-muted-foreground/50',
              children: 'Buckets count every "API call #n" line found in the profile logs — the only per-request record Hermes keeps. It stops at the log rotation point, so "all" is as deep as the retained files go. The two donuts cover the whole snapshot; the line charts and the table follow the period switch. The lines are zero-filled per hour inside the selected window; the table lists only the hours the logs actually have.'
            })
          ]
        })
      })
    ]
  })
}

// ─── page ────────────────────────────────────────────────────────────────────

function StatisticsPage() {
  const { data: snap, error, isFetching, isLoading, refetch } = useSnapshot(true)
  const [tab, setTab] = useState('overview')
  const [agent, setAgent] = useState(null)
  const [task, setTask] = useState(null)

  const openAgent = (name) => {
    setAgent(name)
    setTab('agents')
  }
  const openTrace = (id) => {
    setTask(id)
    setTab('trace')
  }

  if (isLoading && !snap) {
    return jsxs('div', {
      className: 'flex h-full items-center justify-center gap-2 text-[0.8rem] text-muted-foreground/70',
      children: [jsx(GlyphSpinner, {}), 'collecting telemetry…']
    })
  }
  if (error && !snap) {
    return jsx('div', {
      className: 'p-6',
      children: jsx(ErrorState, {
        description: `${error.message} — the collector runs through the gateway's shell.exec RPC and reads state.db, kanban.db and the profile logs.`,
        title: 'Statistics could not collect data'
      })
    })
  }

  return jsxs('div', {
    className: 'flex h-full min-h-0 flex-col gap-3 p-3',
    children: [
      jsxs('div', {
        className: 'flex shrink-0 flex-wrap items-center gap-2',
        children: [
          jsx(Tabs, {
            onValueChange: setTab,
            value: tab,
            children: jsxs(TabsList, {
              children: [
                jsx(TabsTrigger, { value: 'overview', children: 'Overview' }),
                jsx(TabsTrigger, { value: 'agents', children: 'Agents' }),
                jsx(TabsTrigger, { value: 'tasks', children: 'Tasks' }),
                jsx(TabsTrigger, { value: 'trace', children: 'Execution trace' }),
                jsx(TabsTrigger, { value: 'usage', children: 'Usage' }),
                jsx(TabsTrigger, { value: 'activity', children: 'Activity' })
              ]
            })
          }),
          jsxs('div', {
            className: 'ml-auto flex items-center gap-2 text-[0.62rem] text-muted-foreground/50',
            children: [
              jsx('span', {
                children: snap ? `collected ${ago(snap.generated_at)} · ${snap.build_ms}ms · auto-refresh ${Math.round(REFRESH_MS / 1000)}s` : ''
              }),
              jsx(Button, {
                disabled: isFetching,
                onClick: () => refetch(),
                size: 'xs',
                variant: 'outline',
                children: isFetching ? 'refreshing…' : 'Refresh'
              })
            ]
          }, 'agents'),
        ]
      }),
      jsx('div', {
        className: 'flex min-h-0 flex-1 flex-col',
        children:
          tab === 'overview'
            ? jsx(ScrollArea, {
                className: 'min-h-0 flex-1',
                children: jsx('div', { className: 'pr-2', children: jsx(Overview, { onOpenAgent: openAgent, snap }) })
              })
            : tab === 'agents'
              ? jsx(AgentsTab, { onSelect: setAgent, selected: agent, snap })
              : tab === 'tasks'
                ? jsx(TasksTab, { onOpenTrace: openTrace, snap })
                : tab === 'trace'
                  ? jsx(TraceTab, { snap, taskId: task })
                  : tab === 'usage'
                    ? jsx(UsageTab, { snap })
                    : jsx(ActivityTab, { snap })
      })
    ]
  })
}

// ─── statusbar chip (shared query => no second collector run) ────────────────

function StatisticsChip() {
  const { data: snap } = useSnapshot(true)
  const gateway = useValue(host.state.gateway)
  if (!snap) return null
  const errors = (snap.totals.api_failures || 0) + (snap.totals.tool_errors || 0)
  return jsx(Tip, {
    label: `${exact(snap.totals.llm_calls)} LLM requests · ${exact(snap.totals.tool_calls)} tool calls · ${exact(errors)} errors · gateway ${gateway}`,
    children: jsxs('button', {
      className: 'inline-flex h-full items-center gap-1 rounded-none px-1.5 text-[0.6875rem] tabular-nums text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
      onClick: () => host.navigate('/statistics'),
      type: 'button',
      children: [
        jsx(Codicon, { name: 'pulse', size: '0.7rem' }),
        jsx('span', { children: compact(snap.totals.llm_calls) }),
        errors ? jsx(StatusDot, { tone: 'bad' }) : null
      ]
    })
  })
}

// ─── registration ────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Statistics',
  description: 'Fleet dashboard: agents, LLM requests, tool calls, tasks, execution traces, errors and retries — read from Hermes\' own stores.',
  register(ctx) {
    ctx.i18n.register({
      en: { nav: 'Statistics', open: 'Open Statistics' },
      ru: { nav: 'Статистика', open: 'Открыть статистику' }
    })

    const register = () =>
      ctx.registerMany([
        {
          id: 'page',
          area: ROUTES_AREA,
          data: { path: '/statistics' },
          render: () => jsx(StatisticsPage, {})
        },
        {
          id: 'nav',
          area: SIDEBAR_NAV_AREA,
          order: 60,
          data: { codicon: 'pulse', label: ctx.i18n.t('nav'), path: '/statistics' }
        },
        {
          id: 'chip',
          area: STATUSBAR_AREAS.right,
          order: 70,
          render: () => jsx(StatisticsChip, {})
        },
        {
          id: 'open',
          area: PALETTE_AREA,
          data: {
            id: 'statistics.open',
            keywords: ['statistics', 'observability', 'telemetry', 'usage', 'tokens', 'agents', 'traces'],
            label: ctx.i18n.t('open'),
            run: () => host.navigate('/statistics')
          }
        }
      ])

    let dispose = register()
    ctx.i18n.onLocaleChange(() => {
      dispose()
      dispose = register()
    })
  }
}

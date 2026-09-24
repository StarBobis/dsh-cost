/**
 * The `dsh-cost` settings card: the plugin's bundled price table, read-only,
 * above the per-session cost history fed by the session list's projection
 * values. Nothing here writes configuration — prices ship with the plugin.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { IconChevronDownOutline14, IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the keyed plugin-card slot merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: the global standard kit's useSessions seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  formatCostMicros,
  formatTokens,
  hasOffPeak,
  PRICE_CURRENCY,
  selectRate,
  type CostSplitTotal,
  type ModelPrice,
  type PriceTable,
  type TokenBuckets,
} from '../pricing.ts'
import type { BackfillReport } from '../backfill-report.ts'
import { liveTotal, rowCostMicros, rowCostSplitMicros, rowPeriodMicros } from './CostPill.tsx'
import type { CostSettingsSnapshot } from './controller.ts'
import css from './CostCard.module.css'

/** Business share the card's slot registration injects. */
export interface CostCardInjected {
  hooks: {
    /** Settings snapshot bound as useCostSettings. */
    costSettings: import('@deepseek-ai/dsh-client-store').SnapshotStore<CostSettingsSnapshot>
  }
  /** Open one session from a history row. */
  openSession: (sessionId: SessionId) => void
  /**
   * Fold uncounted sessions on the host now, then re-pull the list. Never
   * rejects; resolves with the host sweep report, or undefined when the
   * on-demand sweep was unreachable.
   */
  refreshSessions: () => Promise<BackfillReport | undefined>
}

/** Full card props: global standard kit, injected state and actions, locale. */
export type CostCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<CostCardInjected>
  & PropsLocale<'cost'>

/** One model's four effective rates, as the table displays them. */
interface PriceRow {
  key: string
  /** True when a composition `models` entry supplies this key. */
  configured: boolean
  /** Fold-time tiering: the rate depends on each request's billed input. */
  tiered: boolean
  peak: Required<Omit<ModelPrice, 'tiers' | 'offPeak'>>
  /** The discounted row, present only for prices that publish both periods. */
  offPeak: Required<Omit<ModelPrice, 'tiers' | 'offPeak'>> | null
}

/** One model's usage inside a session history row, priced against the table. */
interface HistoryModelRow {
  key: string
  provider: string
  model: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Peak-window share of the buckets above. */
  peak: TokenBuckets
  /** Live-priced total, or null when the model has no known price. */
  costMicros: number | null
  /** Per-bucket cost split; null when unpriced or folded before split tracking. */
  split: CostSplitTotal | null
  /** Peak/off-peak shares, or null when the model bills one rate. */
  period: { peak: number, offPeak: number } | null
  /** True when billed per request at fold time (later price edits do not revalue). */
  tiered: boolean
}

/** One session's history row: identity plus its per-model usage rows. */
interface HistoryRow {
  sessionId: SessionId
  title: string
  updatedAt: number
  tokens: number
  models: HistoryModelRow[]
  costMicros: number
  unpriced: boolean
}

/** Aggregate cost split over a set of history rows (the header summary). */
interface HistorySummary {
  totalMicros: number
  split: CostSplitTotal
  /** Priced cost whose split is unknowable (legacy tiered folds). */
  unsplitMicros: number
  /** Cost billed inside peak windows; 0 when nothing bills by period. */
  peakMicros: number
  /** Cost billed off-peak. */
  offPeakMicros: number
}

/**
 * How much of the corpus the host has already folded, as far as the session
 * list can tell: `parsed` counts listed sessions whose projection values
 * already carry `cost`, `costable` counts the listed sessions a cost value
 * could attach to at all (blank sessions have no log to fold). Closed forked
 * sessions are the one blind spot — the host withholds every cached value for
 * them — so this pair drives the pre-parse hint only; after a sweep the
 * host-reported numbers below are authoritative.
 */
interface HistoryCoverage {
  /** Listed sessions that can carry a cost value. */
  costable: number
  /** Of those, the ones whose cost value the host has already served. */
  parsed: number
}

/** Outcome of one refresh click: the host report, or an unreachable sweep. */
type RefreshOutcome = { ok: true, report: BackfillReport } | { ok: false }

const modelTokens = (row: HistoryModelRow): number =>
  row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens

const PAGE_SIZES = [10, 20, 50] as const
const PRICE_SELECTION_DEFAULT = 'default'
const PRICE_SELECTION_ALL = 'all'
const PRICE_SELECTION_MODEL_PREFIX = 'model:'

/** The four rates the table shows, in column order. */
const RATE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

/** Compact timestamp for the history table: `2026/9/22 06:49`. */
function formatUpdated(updatedAt: number): string {
  const date = new Date(updatedAt)
  const pad = (value: number): string => `${value}`.padStart(2, '0')
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** One rate cell: `0` stays a plain zero, everything else prints as published. */
function formatRate(rate: number): string {
  return rate === 0 ? '0' : `${rate}`
}

/**
 * Build the displayed price rows from the effective table. Tiered prices show
 * their first (lowest) tier here; the tier note marks the row.
 * @param table - the client's effective price table.
 * @param configured - keys a composition `models` entry supplies.
 * @returns rows sorted by key.
 */
function priceRowsOf(table: PriceTable, configured: ReadonlySet<string>): PriceRow[] {
  return Object.entries(table)
    .map(([key, price]) => ({
      key,
      configured: configured.has(key),
      tiered: price.tiers !== undefined && price.tiers.length > 0,
      peak: selectRate(price, 0, 'peak'),
      offPeak: hasOffPeak(price) ? selectRate(price, 0, 'offPeak') : null,
    }))
    .sort((left, right) => left.key.localeCompare(right.key))
}

/** The collapsible card: bundled price table above, session history below. */
export function CostCard(props: CostCardProps) {
  const { t } = props
  const snapshot = props.useCostSettings(state => state)
  const sessions = props.useSessions(state => state)
  const [open, setOpen] = useState(false)
  /** Show the default set, all prices, or exactly one selected model. */
  const [priceSelection, setPriceSelection] = useState(PRICE_SELECTION_DEFAULT)
  /** Model id the history is filtered to; '' shows every session. */
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0])
  /** Sessions whose per-model breakdown row is expanded. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  /** True while a refresh folds uncounted sessions on the host. */
  const [refreshing, setRefreshing] = useState(false)
  /** Latest refresh outcome; null until one has run in this card. */
  const [outcome, setOutcome] = useState<RefreshOutcome | null>(null)
  /** One-shot: the first expand re-pulls the list so host-backfilled costs land. */
  const autoRefreshed = useRef(false)

  /**
   * Run the host sweep and keep its report: the host folds silently, so this
   * line is the only place a user learns that a refresh added nothing.
   */
  const runRefresh = (): void => {
    setRefreshing(true)
    const done = (next: RefreshOutcome): void => {
      setOutcome(next)
      setRefreshing(false)
    }
    void props.refreshSessions().then(
      report => { done(report === undefined ? { ok: false } : { ok: true, report }) },
      () => { done({ ok: false }) },
    )
  }

  useEffect(() => {
    if (!open || autoRefreshed.current) return
    autoRefreshed.current = true
    runRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const history = useMemo(() => {
    const rows: HistoryRow[] = []
    for (const id of sessions.ids) {
      const item = sessions.byId[id]
      if (item === undefined) continue
      const cost = item.projectionValues?.cost
      if (cost === undefined || cost.models.length === 0) continue
      const live = liveTotal(cost, snapshot.table)
      const models: HistoryModelRow[] = cost.models.map(row => ({
        key: row.key,
        provider: row.provider,
        model: row.model,
        requests: row.requests,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        peak: row.peak,
        costMicros: rowCostMicros(row, snapshot.table),
        split: rowCostSplitMicros(row, snapshot.table),
        period: rowPeriodMicros(row, snapshot.table),
        tiered: row.tiered,
      }))
      rows.push({
        sessionId: item.id,
        title: item.displayTitle,
        updatedAt: item.updatedAt,
        tokens: models.reduce((sum, row) => sum + modelTokens(row), 0),
        models,
        costMicros: live.totalMicros,
        unpriced: live.unpriced.length > 0,
      })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
  }, [sessions, snapshot.table])

  /** Every model id ever billed, sorted for the filter dropdown. */
  const modelOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const row of history) for (const model of row.models) seen.add(model.model)
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [history])

  /** Price rows, in bundle order; the default view narrows to used models. */
  const priceRows = useMemo(
    () => priceRowsOf(snapshot.table, snapshot.configured),
    [snapshot.table, snapshot.configured],
  )

  const defaultPriceRows = useMemo(() => {
    const used = new Set<string>()
    for (const row of history) for (const model of row.models) used.add(model.key)
    return priceRows.filter(row => used.has(row.key) || row.configured || row.key.startsWith('deepseek-official/'))
  }, [priceRows, history])

  const shownPriceRows = useMemo(() => {
    if (priceSelection === PRICE_SELECTION_ALL) return priceRows
    if (priceSelection.startsWith(PRICE_SELECTION_MODEL_PREFIX)) {
      const key = priceSelection.slice(PRICE_SELECTION_MODEL_PREFIX.length)
      return priceRows.filter(row => row.key === key)
    }
    return defaultPriceRows
  }, [defaultPriceRows, priceRows, priceSelection])

  /** How much of the corpus the host has already folded (see HistoryCoverage). */
  const coverage = useMemo(() => {
    const result: HistoryCoverage = { costable: 0, parsed: 0 }
    for (const id of sessions.ids) {
      const item = sessions.byId[id]
      if (item === undefined || item.blank) continue
      result.costable += 1
      if (item.projectionValues?.cost !== undefined) result.parsed += 1
    }
    return result
  }, [sessions])

  /**
   * The rows on display. With a model filter active, a row survives only when
   * it used that model, and its tokens/cost/models shrink to the matching
   * model's share so every downstream figure is the filtered one.
   */
  const view = useMemo(() => {
    if (filter === '') return history
    const rows: HistoryRow[] = []
    for (const row of history) {
      const models = row.models.filter(model => model.model === filter)
      if (models.length === 0) continue
      rows.push({
        ...row,
        models,
        tokens: models.reduce((sum, model) => sum + modelTokens(model), 0),
        costMicros: models.reduce((sum, model) => sum + (model.costMicros ?? 0), 0),
        unpriced: models.some(model => model.costMicros === null),
      })
    }
    return rows
  }, [history, filter])

  const summary = useMemo(() => {
    const split: CostSplitTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    let totalMicros = 0
    let unsplitMicros = 0
    let peakMicros = 0
    let offPeakMicros = 0
    for (const row of view) {
      for (const model of row.models) {
        if (model.costMicros === null) continue
        totalMicros += model.costMicros
        if (model.period !== null) {
          peakMicros += model.period.peak
          offPeakMicros += model.period.offPeak
        }
        if (model.split === null) {
          unsplitMicros += model.costMicros
          continue
        }
        split.input += model.split.input
        split.output += model.split.output
        split.cacheRead += model.split.cacheRead
        split.cacheWrite += model.split.cacheWrite
        split.total += model.split.total
      }
    }
    const result: HistorySummary = { totalMicros, split, unsplitMicros, peakMicros, offPeakMicros }
    return result
  }, [view])

  const pageCount = Math.max(1, Math.ceil(view.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const pageRows = useMemo(
    () => view.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [view, currentPage, pageSize],
  )

  if (snapshot.status === 'unavailable') return null

  return (
    <li className={css.card}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={t('card.title')}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('card.title')}</span>
          <span className={css.description}>{t('card.description')}</span>
        </span>
        <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} />
      </button>
      {open && (
        <div className={css.body}>
          <div className={css.modelsTitle} title={t('card.modelsHint')}>{t('card.models')}</div>
          <p className={css.modelsExplain}>{t('card.modelsExplain')}</p>
          <table className={css.prices}>
            <thead>
              <tr>
                <th>{t('card.modelKey')}</th>
                <th className={css.num}>{t('card.priceInput')}</th>
                <th className={css.num}>{t('card.priceOutput')}</th>
                <th className={css.num}>{t('card.priceCacheRead')}</th>
                <th className={css.num}>{t('card.priceCacheWrite')}</th>
              </tr>
            </thead>
            <tbody>
              {shownPriceRows.map(row => (
                <Fragment key={row.key}>
                  <tr>
                    <td className={css.priceKey}>
                      {row.key}
                      {row.configured && (
                        <span className={css.configuredMark} title={t('card.configuredHint')}>
                          {t('card.configured')}
                        </span>
                      )}
                      {row.tiered && (
                        <span className={css.tieredMark} title={t('card.tieredMark')}>≈</span>
                      )}
                    </td>
                    {RATE_FIELDS.map(field => (
                      <td key={field} className={css.num}>{formatRate(row.peak[field])}</td>
                    ))}
                  </tr>
                  {row.offPeak !== null && (
                    <tr className={css.offPeakRow}>
                      <td className={css.priceKey}>{t('card.offPeakRow')}</td>
                      {RATE_FIELDS.map(field => (
                        <td key={field} className={css.num}>{formatRate(row.offPeak?.[field] ?? 0)}</td>
                      ))}
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          <div className={css.priceFooter}>
            <span className={css.priceUnit}>{PRICE_CURRENCY} / 1M</span>
            <label className={`${css.filterLabel} ${css.priceFilterLabel}`} htmlFor="dsh-cost-price-filter">
              {t('card.priceFilter')}
            </label>
            <select
              id="dsh-cost-price-filter"
              className={css.filterSelect}
              value={priceSelection}
              onChange={event => { setPriceSelection(event.target.value) }}
            >
              <option value={PRICE_SELECTION_DEFAULT}>
                {t('card.showUsedPrices')} ({defaultPriceRows.length}/{priceRows.length})
              </option>
              <option value={PRICE_SELECTION_ALL}>
                {t('card.showAllPrices')} ({priceRows.length})
              </option>
              {priceRows.map(row => (
                <option key={row.key} value={`${PRICE_SELECTION_MODEL_PREFIX}${row.key}`}>{row.key}</option>
              ))}
            </select>
          </div>

          <div className={css.rule} aria-hidden />
          <div className={css.historyTitle}>
            <IconDataOutline16 />
            <span>{t('history.title')}</span>
            <span className={css.historyTotal}>
              {filter === '' ? t('history.total') : `${filter} ${t('history.filteredTotal')}`}: {formatCostMicros(summary.totalMicros)}
            </span>
          </div>
          <div className={css.toolbar}>
            <label className={css.filterLabel} htmlFor="dsh-cost-history-filter">{t('history.filter')}</label>
            <select
              id="dsh-cost-history-filter"
              className={css.filterSelect}
              value={filter}
              onChange={event => {
                setFilter(event.target.value)
                setPage(1)
              }}
            >
              <option value="">{t('history.filterAll')}</option>
              {modelOptions.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
            <button
              type="button"
              className={css.refreshButton}
              title={t('history.refreshHint')}
              disabled={refreshing}
              onClick={runRefresh}
            >
              {t(refreshing ? 'history.refreshing' : 'history.refresh')}
            </button>
          </div>
          {outcome !== null && (
            <p
              className={outcome.ok && outcome.report.failed === 0 ? css.refreshReport : css.moreHint}
              role="status"
            >
              {outcome.ok
                ? (
                  <>
                    {t('history.refreshDone')}:&nbsp;
                    {t('history.refreshAdded')} {outcome.report.folded}
                    &nbsp;·&nbsp;{t('history.refreshFailed')} {outcome.report.failed}
                    &nbsp;·&nbsp;{t('history.refreshListed')} {outcome.report.total}
                  </>
                )
                : t('history.refreshUnavailable')}
            </p>
          )}
          {outcome === null && coverage.costable > coverage.parsed && (
            <p className={css.moreHint} role="status">
              {t('history.maybeMore')} ({coverage.parsed}/{coverage.costable})
            </p>
          )}
          {view.length > 0 && summary.totalMicros > 0 && (
            <p className={css.splitSummary}>
              {t('history.breakdown')}:&nbsp;
              {t('history.colInput')} {formatCostMicros(summary.split.input)}
              &nbsp;·&nbsp;{t('history.colOutput')} {formatCostMicros(summary.split.output)}
              &nbsp;·&nbsp;{t('history.colCacheRead')} {formatCostMicros(summary.split.cacheRead)}
              &nbsp;·&nbsp;{t('history.colCacheWrite')} {formatCostMicros(summary.split.cacheWrite)}
              {summary.offPeakMicros > 0 && (
                <>
                  &nbsp;·&nbsp;{t('history.peak')} {formatCostMicros(summary.peakMicros)}
                  &nbsp;·&nbsp;{t('history.offPeak')} {formatCostMicros(summary.offPeakMicros)}
                </>
              )}
              {summary.unsplitMicros > 0 && (
                <>&nbsp;·&nbsp;{t('history.unsplit')} {formatCostMicros(summary.unsplitMicros)}</>
              )}
            </p>
          )}
          {history.length === 0
            ? <p className={css.empty}>{t('history.empty')}</p>
            : view.length === 0
              ? <p className={css.empty}>{t('history.filterEmpty')}</p>
              : (
                <>
                  <table className={css.history}>
                    <colgroup>
                      <col className={css.colExpander} />
                      <col />
                      <col className={css.colModels} />
                      <col className={css.colUpdated} />
                      <col className={css.colTokens} />
                      <col className={css.colCost} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th className={css.expanderCell} />
                        <th>{t('history.session')}</th>
                        <th>{t('history.model')}</th>
                        <th className={css.num}>{t('history.updated')}</th>
                        <th className={css.num}>{t('history.tokens')}</th>
                        <th className={css.num}>{t('history.cost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map(row => {
                        const isOpen = expanded[row.sessionId] === true
                        return (
                          <Fragment key={row.sessionId}>
                            <tr>
                              <td className={css.expanderCell}>
                                <button
                                  type="button"
                                  className={css.expander}
                                  aria-expanded={isOpen}
                                  aria-label={t(isOpen ? 'history.collapse' : 'history.expand')}
                                  title={t(isOpen ? 'history.collapse' : 'history.expand')}
                                  onClick={() => {
                                    setExpanded(current => ({ ...current, [row.sessionId]: !isOpen }))
                                  }}
                                >
                                  <IconChevronDownOutline14 className={isOpen ? css.chevronOpen : css.chevron} />
                                </button>
                              </td>
                              <td className={css.sessionCell}>
                                <button
                                  type="button"
                                  className={css.sessionLink}
                                  title={`${t('history.open')}: ${row.title ?? row.sessionId}`}
                                  onClick={() => { props.openSession(row.sessionId) }}
                                >
                                  {row.title ?? row.sessionId}
                                </button>
                                {row.unpriced && (
                                  <span className={css.unpricedMark} title={t('history.unpriced')}>!</span>
                                )}
                              </td>
                              <td className={css.modelsCell}>
                                {row.models.map(model => (
                                  <span key={model.key} className={css.modelBadge} title={model.key}>
                                    {model.model}
                                  </span>
                                ))}
                              </td>
                              <td className={css.num}>{formatUpdated(row.updatedAt)}</td>
                              <td className={css.num}>{formatTokens(row.tokens)}</td>
                              <td className={`${css.num} ${css.costCell}`}>{formatCostMicros(row.costMicros)}</td>
                            </tr>
                            {isOpen && (
                              <tr className={css.detailRow}>
                                <td colSpan={6}>
                                  <table className={css.detail}>
                                    <thead>
                                      <tr>
                                        <th>{t('history.model')}</th>
                                        <th className={css.num}>{t('history.requests')}</th>
                                        <th className={css.num}>{t('history.colInput')}</th>
                                        <th className={css.num}>{t('history.colOutput')}</th>
                                        <th className={css.num}>{t('history.colCacheRead')}</th>
                                        <th className={css.num}>{t('history.colCacheWrite')}</th>
                                        <th className={css.num}>{t('history.subtotal')}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {row.models.map(model => (
                                        <tr key={model.key}>
                                          <td className={css.detailModel} title={model.key}>
                                            {model.model}
                                            {model.tiered && (
                                              <span className={css.tieredMark} title={t('dialog.tieredNote')}>≈</span>
                                            )}
                                          </td>
                                          <td className={css.num}>{model.requests}</td>
                                          {([
                                            ['input', model.inputTokens, model.split?.input],
                                            ['output', model.outputTokens, model.split?.output],
                                            ['cacheRead', model.cacheReadTokens, model.split?.cacheRead],
                                            ['cacheWrite', model.cacheWriteTokens, model.split?.cacheWrite],
                                          ] as const).map(([bucket, tokens, micros]) => (
                                            <td key={bucket} className={css.num}>
                                              {micros === undefined
                                                ? <span className={css.dash}>—</span>
                                                : formatCostMicros(micros)}
                                              <span className={css.cellTokens}>{formatTokens(tokens)}</span>
                                            </td>
                                          ))}
                                          <td className={`${css.num} ${css.costCell}`}>
                                            {model.costMicros === null
                                              ? <span className={css.unpriced}>{t('pill.unpriced')}</span>
                                              : formatCostMicros(model.costMicros)}
                                            {model.period !== null && (
                                              <span className={css.cellTokens} title={t('history.periodHint')}>
                                                {t('history.peak')} {formatCostMicros(model.period.peak)}
                                                {' · '}
                                                {t('history.offPeak')} {formatCostMicros(model.period.offPeak)}
                                              </span>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                  {pageCount > 1 && (
                    <div className={css.pagination}>
                      <label className={css.pageSizeLabel}>
                        {t('history.pageSize')}
                        <select
                          className={css.filterSelect}
                          value={pageSize}
                          onChange={event => {
                            setPageSize(Number(event.target.value))
                            setPage(1)
                          }}
                        >
                          {PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
                        </select>
                      </label>
                      <button
                        type="button"
                        className={css.pageButton}
                        disabled={currentPage <= 1}
                        onClick={() => { setPage(currentPage - 1) }}
                      >
                        {t('history.prevPage')}
                      </button>
                      <span className={css.pageStatus}>{currentPage} / {pageCount}</span>
                      <button
                        type="button"
                        className={css.pageButton}
                        disabled={currentPage >= pageCount}
                        onClick={() => { setPage(currentPage + 1) }}
                      >
                        {t('history.nextPage')}
                      </button>
                    </div>
                  )}
                </>
              )}
        </div>
      )}
    </li>
  )
}

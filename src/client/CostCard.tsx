/**
 * The `dsh-cost` settings card: a staged editor for the price table (currency,
 * presets switch, per-model rows) and the per-session cost history fed by the
 * session list's projection values.
 */

import { useMemo, useState } from 'react'
import { IconChevronDownOutline14, IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the keyed plugin-card slot merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// Type-only: the global standard kit's useSessions seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { formatCostMicros, formatTokens, type ModelPrice } from '../pricing.ts'
import { liveTotal } from './CostPill.tsx'
import type { CostSettingsSnapshot } from './controller.ts'
import css from './CostCard.module.css'

/** Business share the card's slot registration injects. */
export interface CostCardInjected {
  hooks: {
    /** Settings snapshot bound as useCostSettings. */
    costSettings: import('@deepseek-ai/dsh-client-store').SnapshotStore<CostSettingsSnapshot>
  }
  /** Persist staged edits through the settings scope. */
  save: (input: { currency: string, presetsEnabled: boolean, models: Record<string, ModelPrice> }) => Promise<void>
  /** Clear every user-layer field so the composition base applies. */
  resetAll: () => Promise<void>
  /** Open one session from a history row. */
  openSession: (sessionId: SessionId) => void
}

/** Full card props: global standard kit, injected state and actions, locale. */
export type CostCardProps =
  PropsRuntime<'settings.plugin.item'>
  & InjectFace<CostCardInjected>
  & PropsLocale<'cost'>

/** One staged price row; numeric fields stay text until save validation. */
interface DraftRow {
  key: string
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
  /** Optional tiers as JSON text; blank means flat billing. */
  tiers: string
}

interface Draft {
  currency: string
  presetsEnabled: boolean
  rows: DraftRow[]
}

const priceToRow = (key: string, price: ModelPrice): DraftRow => ({
  key,
  input: `${price.input}`,
  output: `${price.output}`,
  cacheRead: price.cacheRead === undefined ? '' : `${price.cacheRead}`,
  cacheWrite: price.cacheWrite === undefined ? '' : `${price.cacheWrite}`,
  tiers: price.tiers === undefined ? '' : JSON.stringify(price.tiers),
})

function draftOf(snapshot: CostSettingsSnapshot): Draft {
  return {
    currency: snapshot.currency,
    presetsEnabled: snapshot.presetsEnabled,
    rows: Object.entries(snapshot.models).map(([key, price]) => priceToRow(key, price)),
  }
}

/** A draft row's validation failure, or null when the row parses. */
type RowError = 'card.invalidPrice' | 'card.invalidTiers' | 'card.emptyKey' | 'card.duplicateKey'

function parseRows(rows: readonly DraftRow[]): { models: Record<string, ModelPrice>, errors: (RowError | null)[] } {
  const models: Record<string, ModelPrice> = {}
  const errors: (RowError | null)[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const key = row.key.trim()
    if (key.length === 0) {
      errors.push('card.emptyKey')
      continue
    }
    if (seen.has(key)) {
      errors.push('card.duplicateKey')
      continue
    }
    const input = Number(row.input)
    const output = Number(row.output)
    const cacheRead = row.cacheRead.trim() === '' ? undefined : Number(row.cacheRead)
    const cacheWrite = row.cacheWrite.trim() === '' ? undefined : Number(row.cacheWrite)
    if (![input, output].every(Number.isFinite) || input < 0 || output < 0
      || (cacheRead !== undefined && (!Number.isFinite(cacheRead) || cacheRead < 0))
      || (cacheWrite !== undefined && (!Number.isFinite(cacheWrite) || cacheWrite < 0))) {
      errors.push('card.invalidPrice')
      continue
    }
    let tiers: ModelPrice['tiers']
    if (row.tiers.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(row.tiers)
        if (!Array.isArray(parsed) || parsed.some(tier => typeof tier?.above !== 'number'
          || typeof tier?.input !== 'number' || typeof tier?.output !== 'number')) {
          errors.push('card.invalidTiers')
          continue
        }
        tiers = parsed as ModelPrice['tiers']
      } catch {
        errors.push('card.invalidTiers')
        continue
      }
    }
    seen.add(key)
    models[key] = {
      input,
      output,
      ...cacheRead === undefined ? {} : { cacheRead },
      ...cacheWrite === undefined ? {} : { cacheWrite },
      ...tiers === undefined ? {} : { tiers },
    }
    errors.push(null)
  }
  return { models, errors }
}

/** The collapsible card: price-table editor above, session history below. */
export function CostCard(props: CostCardProps) {
  const { t } = props
  const snapshot = props.useCostSettings(state => state)
  const sessions = props.useSessions(state => state)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  const history = useMemo(() => {
    const rows: { sessionId: SessionId, title: string, updatedAt: number, tokens: number, costMicros: number, unpriced: boolean }[] = []
    for (const id of sessions.ids) {
      const item = sessions.byId[id]
      if (item === undefined) continue
      const cost = item.projectionValues?.cost
      if (cost === undefined || cost.models.length === 0) continue
      const live = liveTotal(cost, snapshot.table)
      const tokens = cost.models.reduce(
        (sum, row) => sum + row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens,
        0,
      )
      rows.push({
        sessionId: item.id,
        title: item.displayTitle,
        updatedAt: item.updatedAt,
        tokens,
        costMicros: live.totalMicros,
        unpriced: live.unpriced.length > 0,
      })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    return rows
  }, [sessions, snapshot.table])

  const historyTotal = useMemo(
    () => history.reduce((sum, row) => sum + row.costMicros, 0),
    [history],
  )

  if (snapshot.status === 'unavailable') return null

  const staged = draft ?? draftOf(snapshot)
  const parsed = parseRows(staged.rows)
  const dirty = draft !== null
  const invalid = parsed.errors.some(error => error !== null)
    || staged.currency.trim().length === 0
  const blocked = !dirty || invalid || saving

  const edit = (next: Draft): void => {
    setDraft(next)
    setFailed(false)
  }

  const editRow = (index: number, patch: Partial<DraftRow>): void => {
    edit({ ...staged, rows: staged.rows.map((row, at) => (at === index ? { ...row, ...patch } : row)) })
  }

  const save = (): void => {
    if (blocked) return
    setSaving(true)
    props.save({
      currency: staged.currency.trim(),
      presetsEnabled: staged.presetsEnabled,
      models: parsed.models,
    }).then(() => {
      setSaving(false)
      setDraft(null)
    }, () => {
      setSaving(false)
      setFailed(true)
    })
  }

  const discard = (): void => {
    setDraft(null)
    setFailed(false)
  }

  const resetAll = (): void => {
    setSaving(true)
    props.resetAll().then(() => {
      setSaving(false)
      setDraft(null)
    }, () => {
      setSaving(false)
      setFailed(true)
    })
  }

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
        {dirty && <span className={css.pending}>{t('card.unsaved')}</span>}
        <IconChevronDownOutline14 className={open ? css.chevronOpen : css.chevron} />
      </button>
      {open && (
        <div className={css.body}>
          {!snapshot.writable && <p className={css.readOnly} role="status">{t('card.readOnly')}</p>}

          <div className={css.fieldRow}>
            <label className={css.fieldLabel} htmlFor="dsh-cost-currency">{t('card.currency')}</label>
            <input
              id="dsh-cost-currency"
              className={css.currencyInput}
              value={staged.currency}
              disabled={!snapshot.writable}
              title={t('card.currencyHint')}
              onChange={event => { edit({ ...staged, currency: event.target.value }) }}
            />
            <label className={css.presetsLabel}>
              <input
                type="checkbox"
                checked={staged.presetsEnabled}
                disabled={!snapshot.writable}
                onChange={event => { edit({ ...staged, presetsEnabled: event.target.checked }) }}
              />
              <span title={t('card.presetsHint')}>{t('card.presets')}</span>
            </label>
          </div>

          <div className={css.modelsTitle} title={t('card.modelsHint')}>{t('card.models')}</div>
          <table className={css.editor}>
            <thead>
              <tr>
                <th>{t('card.modelKey')}</th>
                <th>{t('card.priceInput')}</th>
                <th>{t('card.priceOutput')}</th>
                <th>{t('card.priceCacheRead')}</th>
                <th>{t('card.priceCacheWrite')}</th>
                <th>{t('card.tiers')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {staged.rows.map((row, index) => {
                const error = parsed.errors[index]
                return (
                  <tr key={index} className={error !== null && error !== undefined ? css.rowInvalid : undefined}>
                    <td>
                      <input
                        className={css.keyInput}
                        value={row.key}
                        placeholder="deepseek-chat"
                        disabled={!snapshot.writable}
                        onChange={event => { editRow(index, { key: event.target.value }) }}
                      />
                    </td>
                    {(['input', 'output', 'cacheRead', 'cacheWrite'] as const).map(field => (
                      <td key={field}>
                        <input
                          className={css.priceInput}
                          value={row[field]}
                          placeholder="—"
                          disabled={!snapshot.writable}
                          onChange={event => { editRow(index, { [field]: event.target.value }) }}
                        />
                      </td>
                    ))}
                    <td>
                      <input
                        className={css.tiersInput}
                        value={row.tiers}
                        placeholder="—"
                        title={t('card.tiersHint')}
                        disabled={!snapshot.writable}
                        onChange={event => { editRow(index, { tiers: event.target.value }) }}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className={css.removeButton}
                        disabled={!snapshot.writable}
                        onClick={() => { edit({ ...staged, rows: staged.rows.filter((_, at) => at !== index) }) }}
                      >
                        {t('card.removeModel')}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {parsed.errors.some(error => error !== null) && (
            <p className={css.failed} role="status">
              {t(parsed.errors.find(error => error !== null) ?? 'card.invalidPrice')}
            </p>
          )}
          <button
            type="button"
            className={css.addButton}
            disabled={!snapshot.writable}
            onClick={() => {
              edit({
                ...staged,
                rows: [...staged.rows, { key: '', input: '', output: '', cacheRead: '', cacheWrite: '', tiers: '' }],
              })
            }}
          >
            {t('card.addModel')}
          </button>

          <div className={css.footer}>
            {failed && <p className={css.failed} role="status">{t('card.saveFailed')}</p>}
            <button
              type="button"
              className={css.resetButton}
              disabled={saving}
              onClick={resetAll}
            >
              {t('card.resetAll')}
            </button>
            <button type="button" className={css.discard} disabled={!dirty || saving} onClick={discard}>
              {t('card.discard')}
            </button>
            <button type="button" className={css.save} disabled={blocked} onClick={save}>
              {t(saving ? 'card.saving' : 'card.save')}
            </button>
          </div>

          <div className={css.rule} aria-hidden />
          <div className={css.historyTitle}>
            <IconDataOutline16 />
            <span>{t('history.title')}</span>
            <span className={css.historyTotal}>
              {t('history.total')}: {formatCostMicros(historyTotal, snapshot.currency)}
            </span>
          </div>
          {history.length === 0
            ? <p className={css.empty}>{t('history.empty')}</p>
            : (
              <table className={css.history}>
                <thead>
                  <tr>
                    <th>{t('history.session')}</th>
                    <th>{t('history.updated')}</th>
                    <th>{t('history.tokens')}</th>
                    <th>{t('history.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map(row => (
                    <tr key={row.sessionId}>
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
                      <td>{new Date(row.updatedAt).toLocaleString()}</td>
                      <td>{formatTokens(row.tokens)}</td>
                      <td className={css.costCell}>{formatCostMicros(row.costMicros, snapshot.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </li>
  )
}

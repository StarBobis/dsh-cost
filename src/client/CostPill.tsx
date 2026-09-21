/**
 * The composer-dock cost pill: the session's running total priced against the
 * live table, opening a per-model breakdown dialog. Flat-rate rows reprice
 * from buckets with every settings edit; tiered rows carry the fold-time
 * accumulation.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the dock slot's SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the session standard kit's useProjection seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { CostProjection, CostModelBreakdown } from '../projection-types.ts'
import { bucketsCostMicros, formatCostMicros, formatTokens, resolvePrice, type PriceTable } from '../pricing.ts'
import type { CostSettingsSnapshot } from './controller.ts'
import css from './CostPill.module.css'

/** Business share the pill's slot registration injects. */
export interface CostPillInjected {
  hooks: {
    /** Settings snapshot bound as useCostSettings. */
    costSettings: import('@deepseek-ai/dsh-client-store').SnapshotStore<CostSettingsSnapshot>
  }
}

/** Full pill props: session standard kit, injected prices, and the locale seat. */
export type CostPillProps =
  PropsRuntime<'conversation.composer.dock'>
  & InjectFace<CostPillInjected>
  & PropsLocale<'cost'>

/**
 * Live-price one breakdown row against the client table: tier-billed rows keep
 * their fold-time figure, flat rows reprice from buckets.
 * @param row - one model's view row.
 * @param table - the client's current effective price table.
 * @returns micro-unit cost, or null when the model is unpriced.
 */
export function rowCostMicros(row: CostModelBreakdown, table: PriceTable): number | null {
  const price = resolvePrice(table, row.provider, row.model)
  if (price === undefined) return null
  if (price.tiers !== undefined && price.tiers.length > 0) return row.costMicros ?? 0
  return bucketsCostMicros(price, row)
}

/**
 * Recompute one view's total against a client-side table, so a settings edit
 * reprices the pill in the same frame instead of waiting for the Host view.
 * @param projection - the Host-computed cost view.
 * @param table - the client's current effective price table.
 * @returns total micro-units and the unpriced model keys.
 */
export function liveTotal(
  projection: CostProjection,
  table: PriceTable,
): { totalMicros: number, unpriced: string[] } {
  let totalMicros = 0
  const unpriced: string[] = []
  for (const row of projection.models) {
    const costMicros = rowCostMicros(row, table)
    if (costMicros === null) {
      unpriced.push(row.key)
      continue
    }
    totalMicros += costMicros
  }
  return { totalMicros, unpriced }
}

interface DialogPosition {
  bottom: number
  left: number
}

/** Pill with a click-through dialog listing per-model usage and cost. */
export const CostPill = memo(function CostPill({ useProjection, useCostSettings, t }: CostPillProps) {
  const projection = useProjection('cost')
  const settings = useCostSettings(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<DialogPosition | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) === true || panelRef.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open])

  const live = useMemo(
    () => projection === undefined ? undefined : liveTotal(projection, settings.table),
    [projection, settings.table],
  )

  if (projection === undefined || live === undefined) return null
  if (projection.models.length === 0) return null
  if (settings.status === 'unavailable') return null

  const totalText = formatCostMicros(live.totalMicros, settings.currency)
  const unpricedNote = live.unpriced.length > 0

  const toggle = (): void => {
    if (!open && rootRef.current !== null) {
      const rect = rootRef.current.getBoundingClientRect()
      setPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left })
    }
    setOpen(!open)
  }

  return (
    <span ref={rootRef} className={css.anchor}>
      <button
        type="button"
        className={css.pill}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t('pill.aria')}: ${totalText}`}
        title={unpricedNote ? `${t('pill.aria')} · ${t('pill.unpriced')}` : t('pill.aria')}
        onClick={toggle}
      >
        <IconDataOutline16 />
        <span className={css.label}>{totalText}</span>
        {unpricedNote && <span className={css.unpricedMark} title={t('pill.unpriced')}>!</span>}
      </button>
      {open && pos !== null && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          role="dialog"
          aria-label={t('dialog.title')}
          style={{ bottom: pos.bottom, left: pos.left }}
        >
          <div className={css.panelTitle}>
            <IconDataOutline16 />
            <span>{t('dialog.title')}</span>
            <span className={css.panelTotal}>{totalText}</span>
          </div>
          <div className={css.rule} aria-hidden />
          {projection.models.length === 0
            ? <p className={css.empty}>{t('dialog.empty')}</p>
            : (
              <table className={css.table}>
                <thead>
                  <tr>
                    <th>{t('dialog.model')}</th>
                    <th>{t('dialog.requests')}</th>
                    <th>{t('dialog.input')}</th>
                    <th>{t('dialog.output')}</th>
                    <th>{t('dialog.cacheRead')}</th>
                    <th>{t('dialog.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {projection.models.map(row => (
                    <tr key={row.key}>
                      <td className={css.modelCell} title={row.key}>{row.model}</td>
                      <td>{row.requests}</td>
                      <td>{formatTokens(row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens)}</td>
                      <td>{formatTokens(row.outputTokens)}</td>
                      <td>{formatTokens(row.cacheReadTokens)}</td>
                      <td className={css.costCell}>
                        {(() => {
                          const micros = rowCostMicros(row, settings.table)
                          return micros === null
                            ? <span className={css.unpriced}>{t('pill.unpriced')}</span>
                            : formatCostMicros(micros, settings.currency)
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          {unpricedNote && <p className={css.note}>{t('dialog.unpricedNote')}</p>}
          {projection.models.some(row => row.tiered) && <p className={css.note}>{t('dialog.tieredNote')}</p>}
        </div>,
        document.body,
      )}
    </span>
  )
})

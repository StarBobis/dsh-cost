/**
 * Browser-side bridge over the `dsh-cost` settings scope: one shared snapshot
 * the pill and the settings card read, plus the save path the card submits.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from '../config.ts'
import { effectivePriceTable, type ModelPrice, type PriceTable } from '../pricing.ts'

/** Settings namespace owned by the host plugin. */
export const COST_NS = 'dsh-cost'

/** What the pill and card render. */
export interface CostSettingsSnapshot {
  /** Scope sync state; `unavailable` renders nothing. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Resolved currency label. */
  currency: string
  /** Whether the bundled presets apply. */
  presetsEnabled: boolean
  /** Effective table: presets under the resolved user models. */
  table: PriceTable
  /** Resolved `models` section (composition base plus user layer). */
  models: Record<string, ModelPrice>
  /** Fields whose user layer is present (the override markers). */
  overridden: { currency: boolean, presets: boolean, models: boolean }
}

/** One save's worth of staged edits; undefined leaves the field alone. */
export interface CostSaveInput {
  currency?: string
  presetsEnabled?: boolean
  models?: Record<string, ModelPrice>
}

/**
 * Bind the `dsh-cost` namespace once for every consumer. The snapshot keeps
 * the last accepted section and marks unavailable when the Host serves no
 * such namespace.
 */
export class CostSettingsController {
  /** The shared store; injected as the `useCostSettings` hook. */
  readonly store: SnapshotStore<CostSettingsSnapshot>

  /**
   * @param scope - the bound settings scope for the cost namespace.
   */
  constructor(private readonly scope: SettingsScope<Config>) {
    this.store = createSnapshotStore(this.derive())
    scope.subscribe(() => { this.store.set(this.derive()) })
  }

  private derive(): CostSettingsSnapshot {
    const snapshot = this.scope.getSnapshot()
    const value = snapshot.value
    const currency = value?.currency ?? 'USD'
    const presetsEnabled = value?.presets ?? true
    const models = value?.models ?? {}
    const user = (snapshot.user ?? {}) as Partial<Config>
    return {
      status: snapshot.status,
      writable: snapshot.writable,
      currency,
      presetsEnabled,
      table: effectivePriceTable(presetsEnabled, models),
      models,
      overridden: {
        currency: user.currency !== undefined,
        presets: user.presets !== undefined,
        models: user.models !== undefined,
      },
    }
  }

  /**
   * Write the staged fields in one revision-fenced mutation; each field set
   * here lands in the user layer.
   * @param input - staged edits.
   * @returns settlement of the write.
   */
  async save(input: CostSaveInput): Promise<void> {
    const ops: { op: 'set', path: string[], value: unknown }[] = []
    if (input.currency !== undefined) ops.push({ op: 'set', path: ['currency'], value: input.currency })
    if (input.presetsEnabled !== undefined) ops.push({ op: 'set', path: ['presets'], value: input.presetsEnabled })
    if (input.models !== undefined) ops.push({ op: 'set', path: ['models'], value: input.models })
    if (ops.length === 0) return
    await this.scope.mutate(ops)
  }

  /**
   * Clear every user-layer field, so all values re-inherit the composition.
   * @returns settlement of the write.
   */
  async resetAll(): Promise<void> {
    await this.scope.mutate([
      { op: 'unset', path: ['currency'] },
      { op: 'unset', path: ['presets'] },
      { op: 'unset', path: ['models'] },
    ])
  }
}

/**
 * Browser-side bridge over the `dsh-cost` settings scope: one shared snapshot
 * the pill and the settings card read. Prices themselves are not editable —
 * the snapshot only mirrors the composition's effective table (the plugin's
 * bundled list prices, plus any `models` entry a deployment added).
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Config } from '../config.ts'
import { effectivePriceTable, type PriceTable } from '../pricing.ts'

/** Settings namespace owned by the host plugin. */
export const COST_NS = 'dsh-cost'

/** What the pill and card render. */
export interface CostSettingsSnapshot {
  /** Scope sync state; `unavailable` renders nothing. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Effective table: the bundled list prices under any configured overrides. */
  table: PriceTable
  /** Keys the composition's `models` section supplies (added or overridden). */
  configured: ReadonlySet<string>
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
    const models = snapshot.value?.models ?? {}
    return {
      status: snapshot.status,
      table: effectivePriceTable(models),
      configured: new Set(Object.keys(models)),
    }
  }
}

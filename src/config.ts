/**
 * Shared pure configuration vocabulary for dsh-cost: the plugin Config shape
 * and the settings namespace. Both the host plugin and the browser bundle
 * import this module; it must stay dependency-free so the client compile
 * never drags host-side cordis Context merges in.
 *
 * Prices are NOT configured here. The plugin bundles the published list
 * prices (see `pricing.ts`); the fields below only cover the few facts a
 * deployment can legitimately own — a model the bundle does not know, a
 * holiday the calendar predates, and whether the background sweep runs.
 *
 * @module dsh-cost/config
 */

import type { ModelPrice } from './pricing.ts'

/** Settings namespace whose card carries the price table and session history. */
export const COST_SETTINGS_NAMESPACE = 'dsh-cost'

/** Plugin config (all optional). */
export interface Config {
  /**
   * Extra price entries in USD per 1M tokens, keyed by `model` or
   * `provider/model`, for models the bundled table does not list (or that a
   * deployment prices differently). These override the bundled rows per key.
   * Composition/settings-file level only — the web UI never edits prices.
   */
  models?: Record<string, ModelPrice>
  /**
   * Extra Chinese public-holiday dates (`YYYY-MM-DD`, Beijing) that bill at
   * the off-peak rate all day, for a holiday the bundled calendar predates or
   * a date the State Council moved. Composition/settings-file level only.
   */
  holidays?: string[]
  /**
   * Whether the host sweeps the persisted session corpus in the background
   * and folds cost checkpoints for sessions that predate the plugin (or were
   * never opened since), so the settings history lists every session.
   * Composition-level only. Defaults to true.
   */
  backfill?: boolean
}

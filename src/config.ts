/**
 * Shared pure configuration vocabulary for dsh-cost: the plugin Config shape
 * and the settings namespace. Both the host plugin and the browser bundle
 * import this module; it must stay dependency-free so the client compile
 * never drags host-side cordis Context merges in.
 *
 * @module dsh-cost/config
 */

import type { ModelPrice } from './pricing.ts'

/** Settings namespace carrying the runtime-editable price table. */
export const COST_SETTINGS_NAMESPACE = 'dsh-cost'

/** Plugin config (all optional — schema defaults supply a usable table). */
export interface Config {
  /** Currency label for display; the bundled presets are USD list prices. Defaults to `USD`. */
  currency?: string
  /** Whether the bundled OpenCode Zen preset prices apply. Defaults to true. */
  presets?: boolean
  /**
   * User price table in currency per 1M tokens, keyed by `model` or
   * `provider/model`; overrides presets per key. A model absent here and from
   * the presets is reported as unpriced and contributes no cost.
   */
  models?: Record<string, ModelPrice>
}

/**
 * dsh-cost host plugin: per-model token price configuration and the `cost`
 * session projection. The fold replays durable usage events into per-model
 * token buckets; the client view prices them against the configured table.
 *
 * Configuration resolves from the composition entry, then the `dsh-cost`
 * settings namespace when a settings service is mounted, so price edits in
 * the web UI apply without a restart.
 *
 * @module dsh-cost
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-settings'
import { COST_SETTINGS_NAMESPACE, type Config as ConfigShape } from './config.ts'
import { costProjectionDefinition } from './projection.ts'
import { effectivePriceTable, type ResolvedPrices } from './pricing.ts'

export { COST_SETTINGS_NAMESPACE } from './config.ts'
export { costProjectionDefinition } from './projection.ts'
export type { CostModelBreakdown, CostProjection, CostState } from './projection-types.ts'
export {
  bucketsCostMicros,
  effectivePriceTable,
  formatCostMicros,
  formatTokens,
  resolvePrice,
  selectRate,
  usageCostMicros,
  ZEN_PRESETS,
} from './pricing.ts'
export type { ModelPrice, ModelPriceTier, PriceTable, ResolvedPrices, TokenBuckets } from './pricing.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-cost'

/** Required seams: the projection registry this plugin contributes to. */
export const inject = ['sessionProjections']

const priceFields = {
  /** Input (uncached prompt) tokens, per 1M. */
  input: z.number().min(0),
  /** Output tokens, per 1M. */
  output: z.number().min(0),
  /** Cache-read tokens, per 1M; defaults to the input rate when absent. */
  cacheRead: z.number().min(0),
  /** Cache-write tokens, per 1M; defaults to the input rate when absent. */
  cacheWrite: z.number().min(0),
}

/** Plugin config (all optional — schema defaults supply a usable table). */
export type Config = ConfigShape

export const Config: z<ConfigShape> = z.object({
  currency: z.string().default('USD'),
  presets: z.boolean().default(true),
  models: z.dict(z.object({
    ...priceFields,
    /** Per-request tiers: the highest tier whose `above` the request's billed input exceeds wins. */
    tiers: z.array(z.object({
      above: z.natural(),
      ...priceFields,
    })),
  })).default({}),
})

/**
 * Mount the cost projection. The price source starts at the composition entry
 * and swaps to the resolved `dsh-cost` settings section while a settings
 * service is attached.
 * @param ctx - plugin context.
 * @param config - composition entry config.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  let source: () => ConfigShape = () => config
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, COST_SETTINGS_NAMESPACE, Config, config, {
      setSource: (current) => {
        source = current
      },
      onChange: () => {},
    })
  })

  // The resolved table rebuilds only when the authoritative section's
  // reference moves, so the projection view's memoization stays effective.
  let cachedFor: ConfigShape | undefined
  let cached: ResolvedPrices | undefined
  const prices = (): ResolvedPrices => {
    const section = source()
    if (cached !== undefined && cachedFor === section) return cached
    cachedFor = section
    cached = {
      currency: section.currency ?? 'USD',
      table: effectivePriceTable(section.presets ?? true, section.models),
    }
    return cached
  }

  ctx.sessionProjections.register(costProjectionDefinition(prices))
}

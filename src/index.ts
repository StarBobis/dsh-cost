/**
 * dsh-cost host plugin: the `cost` session projection over the plugin's
 * bundled price table. The fold replays durable usage events into per-model
 * token buckets (split by billing period for prices with an off-peak row);
 * the client view prices those buckets against the table.
 *
 * Prices ship with the plugin. The `dsh-cost` settings namespace exists for
 * the settings card (and for a composition that needs to price a model the
 * bundle does not list); nothing in the web UI edits prices.
 *
 * @module dsh-cost
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-settings'
import { COST_SETTINGS_NAMESPACE, type Config as ConfigShape } from './config.ts'
import { CostBackfill, CostBackfillService } from './backfill.ts'
import { costProjectionDefinition } from './projection.ts'
import { effectivePriceTable, type ResolvedPrices } from './pricing.ts'

export { COST_SETTINGS_NAMESPACE } from './config.ts'
export { CostBackfill, CostBackfillService } from './backfill.ts'
export type { BackfillReport } from './backfill.ts'
export { costProjectionDefinition } from './projection.ts'
export type { CostModelBreakdown, CostProjection, CostState } from './projection-types.ts'
export {
  bucketsCostMicros,
  bucketsCostSplitMicros,
  BUILTIN_PRICES,
  CHINA_PUBLIC_HOLIDAYS,
  DEEPSEEK_PRICES,
  effectivePriceTable,
  formatCostMicros,
  formatTokens,
  PEAK_WINDOWS,
  periodCostMicros,
  periodCostSplitMicros,
  periodOf,
  PRICE_CURRENCY,
  resolvePrice,
  selectRate,
  subtractBuckets,
  usageCostMicros,
  usageCostSplitMicros,
  ZEN_PRESETS,
} from './pricing.ts'
export type {
  CostSplit,
  CostSplitTotal,
  ModelPrice,
  ModelPriceTier,
  PricePeriod,
  PriceTable,
  ResolvedPrices,
  TokenBuckets,
} from './pricing.ts'

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

/** Plugin config (all optional — the bundled table needs no configuration). */
export type Config = ConfigShape

export const Config: z<ConfigShape> = z.object({
  models: z.dict(z.object({
    ...priceFields,
    /** Per-request tiers: the highest tier whose `above` the request's billed input exceeds wins. */
    tiers: z.array(z.object({
      above: z.natural(),
      ...priceFields,
    })),
    /** Discounted rates billed outside the peak windows (DeepSeek-style off-peak). */
    offPeak: z.object(priceFields).description('off-peak rates'),
  })).default({}),
  holidays: z.array(z.string()).default([]),
  backfill: z.boolean().default(true),
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
      table: effectivePriceTable(section.models),
      holidays: section.holidays ?? [],
    }
    return cached
  }

  ctx.sessionProjections.register(costProjectionDefinition(prices))

  // The Remote stays mounted even when the background sweep is disabled, so
  // the settings card's refresh button always folds on demand.
  const backfill = new CostBackfill(ctx)
  new CostBackfillService(ctx, backfill)
  if (config.backfill ?? true) {
    ctx.effect(() => backfill.startBackground(), 'dsh-cost: history backfill')
  }
}

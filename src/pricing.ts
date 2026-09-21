/**
 * Shared pure pricing vocabulary for dsh-cost: price tables, the bundled
 * OpenCode Zen preset table, model matching, and micro-unit cost math.
 *
 * Costs are carried as integer micro-units (1/1_000_000 of the table's
 * currency): `tokens * pricePerMillion` is already a micro-unit figure, so
 * accumulation never drifts through floats. Both the host fold and the
 * browser bundle import this module; it must stay dependency-free.
 *
 * @module dsh-cost/pricing
 */

/** One price tier: rates in currency per 1M tokens. */
export interface ModelPriceTier {
  /** Billed input tokens (uncached + cache read + cache write) above which this tier applies. */
  above: number
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Flat rates per 1M tokens, plus optional per-request tiers. A price with
 * `tiers` is billed per request at fold time (the request's billed input size
 * selects the tier); a flat price is billed from cumulative buckets, so edits
 * revalue history instantly.
 */
export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  tiers?: ModelPriceTier[]
}

/** Price table: keys are `model` or `provider/model`, values per 1M tokens. */
export type PriceTable = Record<string, ModelPrice>

/** Disjoint provider-reported token buckets. */
export interface TokenBuckets {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** A resolved pricing view: the currency label plus the effective table. */
export interface ResolvedPrices {
  currency: string
  table: PriceTable
}

/**
 * Look up the price for one routed request. An exact `provider/model` key
 * wins over a bare `model` key, so one table can price the same model id
 * differently per provider.
 * @param table - effective price table.
 * @param provider - request provider id.
 * @param model - request model id.
 * @returns the matching price, or undefined when the model is unconfigured.
 */
export function resolvePrice(table: PriceTable, provider: string, model: string): ModelPrice | undefined {
  return table[`${provider}/${model}`] ?? table[model]
}

/**
 * Select the rate row for one request: the flat fields, or the highest tier
 * whose `above` the request's billed input exceeds.
 * @param price - the matched model price.
 * @param billedInputTokens - the request's uncached + cache-read + cache-write input tokens.
 * @returns the rates that bill this request.
 */
export function selectRate(price: ModelPrice, billedInputTokens: number): Required<Omit<ModelPrice, 'tiers'>> {
  let rate = price
  if (price.tiers !== undefined) {
    for (const tier of price.tiers) {
      if (billedInputTokens > tier.above && (rate === price || tier.above >= (rate as ModelPriceTier).above)) {
        rate = tier
      }
    }
  }
  return {
    input: rate.input,
    output: rate.output,
    cacheRead: rate.cacheRead ?? rate.input,
    cacheWrite: rate.cacheWrite ?? rate.input,
  }
}

/**
 * Price one request's usage in micro-units. Tier-aware: the request's own
 * billed input selects the rate row.
 * @param price - the matched model price.
 * @param usage - one request's reported usage.
 * @returns micro-unit cost.
 */
export function usageCostMicros(price: ModelPrice, usage: TokenBuckets): number {
  const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const rate = selectRate(price, billedInput)
  return Math.round(
    usage.inputTokens * rate.input
    + usage.outputTokens * rate.output
    + usage.cacheReadTokens * rate.cacheRead
    + usage.cacheWriteTokens * rate.cacheWrite,
  )
}

/**
 * Price cumulative buckets under the flat rate row. Used for tier-less
 * prices, where history revalues live as the table changes.
 * @param price - the matched model price (must not declare tiers).
 * @param buckets - cumulative per-model token buckets.
 * @returns micro-unit cost.
 */
export function bucketsCostMicros(price: ModelPrice, buckets: TokenBuckets): number {
  const rate = selectRate(price, 0)
  return Math.round(
    buckets.inputTokens * rate.input
    + buckets.outputTokens * rate.output
    + buckets.cacheReadTokens * rate.cacheRead
    + buckets.cacheWriteTokens * rate.cacheWrite,
  )
}

/**
 * Build the effective table: the bundled presets underneath the user's own
 * `models` section, which overrides per key.
 * @param presetsEnabled - whether the bundled OpenCode Zen presets apply.
 * @param models - the user's own price entries.
 * @returns the merged table.
 */
export function effectivePriceTable(presetsEnabled: boolean, models: PriceTable | undefined): PriceTable {
  return {
    ...(presetsEnabled ? ZEN_PRESETS : {}),
    ...(models ?? {}),
  }
}

const TIER_200K = 200_000
const TIER_272K = 272_000

/**
 * Bundled OpenCode Zen list prices (USD per 1M tokens), mirrored from
 * https://opencode.ai/docs/zen#pricing. Models that are free on every bucket
 * are omitted. Tiered rows keep the lower-context rate in the flat fields and
 * the higher-context rate in `tiers`.
 */
export const ZEN_PRESETS: PriceTable = {
  'jev-1.13': { input: 0.042, output: 0 },
  'minimax-m3': { input: 0.30, output: 1.20, cacheRead: 0.06 },
  'minimax-m2.7': { input: 0.30, output: 1.20, cacheRead: 0.06 },
  'minimax-m2.5': { input: 0.30, output: 1.20, cacheRead: 0.06 },
  'glm-5.3-flash': { input: 0.15, output: 0.50, cacheRead: 0.03 },
  'glm-5.3': { input: 1.40, output: 4.40, cacheRead: 0.26 },
  'glm-5.2': { input: 1.40, output: 4.40, cacheRead: 0.26 },
  'glm-5.1': { input: 1.40, output: 4.40, cacheRead: 0.26 },
  'glm-5': { input: 1.00, output: 3.20, cacheRead: 0.20 },
  'kimi-k2.7-code': { input: 0.95, output: 4.00, cacheRead: 0.19 },
  'kimi-k3': { input: 3.00, output: 15.00, cacheRead: 0.30 },
  'kimi-k2.6': { input: 0.95, output: 4.00, cacheRead: 0.16 },
  'kimi-k2.5': { input: 0.60, output: 3.00, cacheRead: 0.10 },
  'qwen3.8-flash': { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.20 },
  'qwen3.7-max': { input: 2.50, output: 7.50, cacheRead: 0.50, cacheWrite: 3.125 },
  'qwen3.7-plus': { input: 0.40, output: 1.60, cacheRead: 0.04, cacheWrite: 0.50 },
  'qwen3.6-plus': { input: 0.50, output: 3.00, cacheRead: 0.05, cacheWrite: 0.625 },
  'qwen3.5-plus': { input: 0.20, output: 1.20, cacheRead: 0.02, cacheWrite: 0.25 },
  'deepseek-v4.1-flash': { input: 0.30, output: 1.20, cacheRead: 0.006 },
  'deepseek-v4-pro': { input: 1.74, output: 3.48, cacheRead: 0.145 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.028 },
  'deepseek-v4-flash-vision-exp': { input: 0.14, output: 0.28, cacheRead: 0.028 },
  'claude-fable-5-1': { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 },
  'claude-fable-5': { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
  'claude-opus-5': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-sonnet-4-5': {
    input: 3.00,
    output: 15.00,
    cacheRead: 0.30,
    cacheWrite: 3.75,
    tiers: [{ above: TIER_200K, input: 6.00, output: 22.50, cacheRead: 0.60, cacheWrite: 7.50 }],
  },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  'gemini-3.8-flash': { input: 1.50, output: 7.50, cacheRead: 0.15 },
  'gemini-3.7-flash': { input: 1.50, output: 7.50, cacheRead: 0.15 },
  'gemini-3.6-flash': { input: 1.50, output: 7.50, cacheRead: 0.15 },
  'gemini-3.5-flash': { input: 1.50, output: 9.00, cacheRead: 0.15 },
  'gemini-3.5-flash-lite': { input: 0.30, output: 2.50, cacheRead: 0.03 },
  'gemini-3.1-pro': {
    input: 2.00,
    output: 12.00,
    cacheRead: 0.20,
    tiers: [{ above: TIER_200K, input: 4.00, output: 18.00, cacheRead: 0.40 }],
  },
  'gemini-3-flash': { input: 0.50, output: 3.00, cacheRead: 0.05 },
  'grok-4.6': {
    input: 2.00,
    output: 6.00,
    cacheRead: 0.50,
    tiers: [{ above: TIER_200K, input: 4.00, output: 12.00, cacheRead: 1.00 }],
  },
  'grok-4.5': {
    input: 2.00,
    output: 6.00,
    cacheRead: 0.30,
    tiers: [{ above: TIER_200K, input: 4.00, output: 12.00, cacheRead: 0.60 }],
  },
  'grok-build-0.1': { input: 1.00, output: 2.00, cacheRead: 0.20 },
  'muse-spark-1.3': { input: 1.25, output: 4.25, cacheRead: 0.15 },
  'muse-spark-1.2': { input: 1.25, output: 4.25, cacheRead: 0.15 },
  'gpt-6-astra': {
    input: 10.00,
    output: 50.00,
    cacheRead: 1.00,
    cacheWrite: 12.50,
    tiers: [{ above: TIER_272K, input: 20.00, output: 75.00, cacheRead: 2.00, cacheWrite: 25.00 }],
  },
  'gpt-5.6-sol': {
    input: 4.00,
    output: 20.00,
    cacheRead: 0.40,
    cacheWrite: 5.00,
    tiers: [{ above: TIER_272K, input: 8.00, output: 30.00, cacheRead: 0.80, cacheWrite: 10.00 }],
  },
  'gpt-5.6-terra': {
    input: 2.00,
    output: 12.00,
    cacheRead: 0.20,
    cacheWrite: 2.50,
    tiers: [{ above: TIER_272K, input: 4.00, output: 18.00, cacheRead: 0.40, cacheWrite: 5.00 }],
  },
  'gpt-5.6-luna': {
    input: 0.20,
    output: 1.20,
    cacheRead: 0.02,
    cacheWrite: 0.25,
    tiers: [{ above: TIER_272K, input: 0.40, output: 1.80, cacheRead: 0.04, cacheWrite: 0.50 }],
  },
  'gpt-5.5': {
    input: 5.00,
    output: 30.00,
    cacheRead: 0.50,
    tiers: [{ above: TIER_272K, input: 10.00, output: 45.00, cacheRead: 1.00 }],
  },
  'gpt-5.5-pro': { input: 30.00, output: 180.00, cacheRead: 30.00 },
  'gpt-5.4': {
    input: 2.50,
    output: 15.00,
    cacheRead: 0.25,
    tiers: [{ above: TIER_272K, input: 5.00, output: 22.50, cacheRead: 0.50 }],
  },
  'gpt-5.4-pro': { input: 30.00, output: 180.00, cacheRead: 30.00 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50, cacheRead: 0.075 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25, cacheRead: 0.02 },
  'gpt-5.3-codex-spark': { input: 1.75, output: 14.00, cacheRead: 0.175 },
  'gpt-5.3-codex': { input: 1.75, output: 14.00, cacheRead: 0.175 },
  'gpt-5.2': { input: 1.75, output: 14.00, cacheRead: 0.175 },
  'gpt-5.2-codex': { input: 1.75, output: 14.00, cacheRead: 0.175 },
  'gpt-5.1': { input: 1.07, output: 8.50, cacheRead: 0.107 },
  'gpt-5.1-codex': { input: 1.07, output: 8.50, cacheRead: 0.107 },
  'gpt-5.1-codex-max': { input: 1.25, output: 10.00, cacheRead: 0.125 },
  'gpt-5.1-codex-mini': { input: 0.25, output: 2.00, cacheRead: 0.025 },
  'gpt-5': { input: 1.07, output: 8.50, cacheRead: 0.107 },
  'gpt-5-codex': { input: 1.07, output: 8.50, cacheRead: 0.107 },
  'gpt-5-nano': { input: 0.05, output: 0.40, cacheRead: 0.005 },
}

/**
 * Format one micro-unit figure for display: fixed 4 decimals below 0.01,
 * 2 decimals from 100 up, adaptive in between.
 * @param micros - micro-unit cost.
 * @param currency - currency label (e.g. `USD`, `CNY`) or a literal symbol.
 * @returns display string such as `$0.0034`.
 */
export function formatCostMicros(micros: number, currency: string): string {
  const value = micros / 1_000_000
  const decimals = value === 0 ? 2 : value < 0.01 ? 4 : value < 100 ? 4 : 2
  const text = value.toFixed(decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.00')
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `
  return `${symbol}${text}`
}

/**
 * Compact token count: 12.3k under a million, 1.2M from there on.
 * @param tokens - token count.
 * @returns display string.
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
}

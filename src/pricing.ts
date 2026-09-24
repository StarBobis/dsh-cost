/**
 * Shared pure pricing vocabulary for dsh-cost: the bundled price table
 * (DeepSeek list prices plus the OpenCode Zen catalog), model matching,
 * peak/off-peak period selection, and micro-unit cost math.
 *
 * Costs are carried as integer micro-units (1/1_000_000 USD): `tokens *
 * pricePerMillion` is already a micro-unit figure, so accumulation never
 * drifts through floats. Both the host fold and the browser bundle import
 * this module; it must stay dependency-free.
 *
 * Every price in the bundled table is a published list price in USD per 1M
 * tokens — the plugin ships them, users do not configure them.
 *
 * @module dsh-cost/pricing
 */

/** The currency every bundled price and every computed cost is expressed in. */
export const PRICE_CURRENCY = 'USD'

/** One price tier: rates in USD per 1M tokens. */
export interface ModelPriceTier {
  /** Billed input tokens (uncached + cache read + cache write) above which this tier applies. */
  above: number
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/** The half of a price that bills outside the peak windows. */
export interface OffPeakPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

/**
 * Flat rates per 1M tokens, plus optional per-request tiers. A price with
 * `tiers` is billed per request at fold time (the request's billed input size
 * selects the tier); a flat price is billed from cumulative buckets.
 *
 * A price carrying `offPeak` bills by request time instead (see
 * {@link periodOf}): the flat fields are the peak rates and `offPeak` the
 * discounted ones.
 */
export interface ModelPrice {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  tiers?: ModelPriceTier[]
  /** Discounted rates billed outside every peak window. */
  offPeak?: OffPeakPrice
}

/** Which published rate row bills one request. */
export type PricePeriod = 'peak' | 'offPeak'

/**
 * Whether a price publishes usable off-peak rates. A schema-resolved config
 * entry can carry an EMPTY `offPeak` object (the config schema materializes
 * the key), which is not a discount — reading its rates would produce NaN.
 * @param price - the matched model price, if any.
 * @returns true when the off-peak row carries both required rates.
 */
export function hasOffPeak(price: ModelPrice | undefined): boolean {
  const offPeak = price?.offPeak
  return offPeak !== undefined && Number.isFinite(offPeak.input) && Number.isFinite(offPeak.output)
}

/**
 * Drop a rate object the config schema materialized without values, so the
 * effective table never carries a half-built off-peak row.
 * @param price - one configured price entry.
 * @returns the entry, with an unusable `offPeak` and an empty `tiers` removed.
 */
function normalizePrice(price: ModelPrice): ModelPrice {
  const { offPeak, tiers, ...rest } = price
  return {
    ...rest,
    ...tiers === undefined || tiers.length === 0 ? {} : { tiers },
    ...hasOffPeak(price) ? { offPeak } : {},
  }
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

/** A resolved pricing view: the effective table plus the extra holiday dates. */
export interface ResolvedPrices {
  table: PriceTable
  /** Composition-supplied extra public-holiday dates (`YYYY-MM-DD`, Beijing). */
  holidays?: readonly string[]
}

/** Per-bucket micro-unit cost split; the parts always sum to `total`. */
export interface CostSplit {
  /** Uncached input tokens billed at the input rate. */
  input: number
  /** Output tokens billed at the output rate. */
  output: number
  /** Cache-read tokens billed at the cache-read rate. */
  cacheRead: number
  /** Cache-write tokens billed at the cache-write rate. */
  cacheWrite: number
}

/** A cost split plus its total (the exact sum of the four parts). */
export type CostSplitTotal = CostSplit & { total: number }

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
 * Select the rate row for one request: the flat fields (or the period's
 * discounted fields), or the highest tier whose `above` the request's billed
 * input exceeds.
 * @param price - the matched model price.
 * @param billedInputTokens - the request's uncached + cache-read + cache-write input tokens.
 * @param period - the request's billing period; `peak` unless the price has an off-peak row.
 * @returns the rates that bill this request.
 */
export function selectRate(
  price: ModelPrice,
  billedInputTokens: number,
  period: PricePeriod = 'peak',
): Required<Omit<ModelPrice, 'tiers' | 'offPeak'>> {
  const base: ModelPrice | OffPeakPrice = period === 'offPeak' && hasOffPeak(price)
    ? price.offPeak as OffPeakPrice
    : price
  let rate: ModelPrice | OffPeakPrice | ModelPriceTier = base
  if (price.tiers !== undefined) {
    for (const tier of price.tiers) {
      if (billedInputTokens > tier.above && (rate === base || tier.above >= (rate as ModelPriceTier).above)) {
        rate = tier
      }
    }
  }
  // The flat row is the fallback for a partial row (a tier without every
  // rate, or a rate-less off-peak object): never emit a NaN rate.
  const flat: ModelPrice = Number.isFinite(rate.input) && Number.isFinite(rate.output) ? rate : price
  return {
    input: flat.input,
    output: flat.output,
    cacheRead: flat.cacheRead ?? flat.input,
    cacheWrite: flat.cacheWrite ?? flat.input,
  }
}

/**
 * Price one request's usage in micro-units. Tier-aware: the request's own
 * billed input selects the rate row.
 * @param price - the matched model price.
 * @param usage - one request's reported usage.
 * @param period - the request's billing period.
 * @returns micro-unit cost.
 */
export function usageCostMicros(price: ModelPrice, usage: TokenBuckets, period: PricePeriod = 'peak'): number {
  const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const rate = selectRate(price, billedInput, period)
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
 * @param period - the rate row to apply.
 * @returns micro-unit cost.
 */
export function bucketsCostMicros(price: ModelPrice, buckets: TokenBuckets, period: PricePeriod = 'peak'): number {
  const rate = selectRate(price, 0, period)
  return Math.round(
    buckets.inputTokens * rate.input
    + buckets.outputTokens * rate.output
    + buckets.cacheReadTokens * rate.cacheRead
    + buckets.cacheWriteTokens * rate.cacheWrite,
  )
}

/**
 * Price one request's usage in micro-units, split per bucket. Each bucket is
 * rounded on its own so the displayed parts sum exactly to `total`; the
 * request's own billed input selects the rate row when tiers apply.
 * @param price - the matched model price.
 * @param usage - one request's reported usage.
 * @param period - the request's billing period.
 * @returns per-bucket micro-unit costs and their total.
 */
export function usageCostSplitMicros(
  price: ModelPrice,
  usage: TokenBuckets,
  period: PricePeriod = 'peak',
): CostSplitTotal {
  const billedInput = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const rate = selectRate(price, billedInput, period)
  const split: CostSplit = {
    input: Math.round(usage.inputTokens * rate.input),
    output: Math.round(usage.outputTokens * rate.output),
    cacheRead: Math.round(usage.cacheReadTokens * rate.cacheRead),
    cacheWrite: Math.round(usage.cacheWriteTokens * rate.cacheWrite),
  }
  return { ...split, total: split.input + split.output + split.cacheRead + split.cacheWrite }
}

/**
 * Price cumulative buckets under the flat rate row, split per bucket. Each
 * bucket is rounded on its own so the displayed parts sum exactly to
 * `total`; used for tier-less prices, where history revalues live.
 * @param price - the matched model price (must not declare tiers).
 * @param buckets - cumulative per-model token buckets.
 * @param period - the rate row to apply.
 * @returns per-bucket micro-unit costs and their total.
 */
export function bucketsCostSplitMicros(
  price: ModelPrice,
  buckets: TokenBuckets,
  period: PricePeriod = 'peak',
): CostSplitTotal {
  const rate = selectRate(price, 0, period)
  const split: CostSplit = {
    input: Math.round(buckets.inputTokens * rate.input),
    output: Math.round(buckets.outputTokens * rate.output),
    cacheRead: Math.round(buckets.cacheReadTokens * rate.cacheRead),
    cacheWrite: Math.round(buckets.cacheWriteTokens * rate.cacheWrite),
  }
  return { ...split, total: split.input + split.output + split.cacheRead + split.cacheWrite }
}

/** Every bucket zeroed, for rows that never billed inside a peak window. */
export const ZERO_BUCKETS: TokenBuckets = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

/**
 * The part of `buckets` that is NOT inside `part`, bucket by bucket, clamped
 * at zero so a rounding or legacy mismatch can never produce a negative bill.
 * @param buckets - the whole accumulation.
 * @param part - the subset to remove.
 * @returns the remaining buckets.
 */
export function subtractBuckets(buckets: TokenBuckets, part: TokenBuckets): TokenBuckets {
  return {
    inputTokens: Math.max(0, buckets.inputTokens - part.inputTokens),
    outputTokens: Math.max(0, buckets.outputTokens - part.outputTokens),
    cacheReadTokens: Math.max(0, buckets.cacheReadTokens - part.cacheReadTokens),
    cacheWriteTokens: Math.max(0, buckets.cacheWriteTokens - part.cacheWriteTokens),
  }
}

/**
 * Price cumulative buckets across both periods: the recorded peak subset at
 * the peak rates and the rest at the off-peak rates.
 * @param price - the matched model price with an `offPeak` row.
 * @param buckets - cumulative per-model token buckets.
 * @param peak - the subset of `buckets` folded inside peak windows.
 * @returns micro-unit cost.
 */
export function periodCostMicros(price: ModelPrice, buckets: TokenBuckets, peak: TokenBuckets | undefined): number {
  if (!hasOffPeak(price)) return bucketsCostMicros(price, buckets)
  const inPeak = peak ?? ZERO_BUCKETS
  return bucketsCostMicros(price, inPeak, 'peak')
    + bucketsCostMicros(price, subtractBuckets(buckets, inPeak), 'offPeak')
}

/**
 * Price cumulative buckets across both periods, split per bucket. The peak
 * and off-peak splits are summed bucket by bucket, so the parts still sum
 * exactly to `total`.
 * @param price - the matched model price with an `offPeak` row.
 * @param buckets - cumulative per-model token buckets.
 * @param peak - the subset of `buckets` folded inside peak windows.
 * @returns per-bucket micro-unit costs and their total.
 */
export function periodCostSplitMicros(
  price: ModelPrice,
  buckets: TokenBuckets,
  peak: TokenBuckets | undefined,
): CostSplitTotal {
  if (!hasOffPeak(price)) return bucketsCostSplitMicros(price, buckets)
  const inPeak = peak ?? ZERO_BUCKETS
  const peakSplit = bucketsCostSplitMicros(price, inPeak, 'peak')
  const offPeakSplit = bucketsCostSplitMicros(price, subtractBuckets(buckets, inPeak), 'offPeak')
  const split: CostSplit = {
    input: peakSplit.input + offPeakSplit.input,
    output: peakSplit.output + offPeakSplit.output,
    cacheRead: peakSplit.cacheRead + offPeakSplit.cacheRead,
    cacheWrite: peakSplit.cacheWrite + offPeakSplit.cacheWrite,
  }
  return { ...split, total: split.input + split.output + split.cacheRead + split.cacheWrite }
}

/**
 * Build the effective table: the bundled list prices under the composition's
 * own `models` entries, which override per key. The bundled table always
 * applies — there is no user-facing switch and no user-editable price state.
 * @param models - composition/config price entries for models the bundle does
 * not know (or deliberately re-prices).
 * @returns the merged table.
 */
export function effectivePriceTable(models: PriceTable | undefined): PriceTable {
  if (models === undefined) return { ...BUILTIN_PRICES }
  const merged: PriceTable = { ...BUILTIN_PRICES }
  for (const [key, price] of Object.entries(models)) {
    if (price !== undefined) merged[key] = normalizePrice(price)
  }
  return merged
}

/**
 * Peak windows in Beijing wall-clock minutes, covering the published rule
 * "北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00".
 * The end of a window is exclusive, so 12:00 and 18:00 already bill off-peak.
 */
export const PEAK_WINDOWS: readonly (readonly [number, number])[] = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/**
 * Beijing time never observes DST, so one fixed offset converts UTC epoch
 * milliseconds into the wall clock the pricing rule is written in.
 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * Chinese public holidays (`YYYY-MM-DD`, Beijing dates) treated as fully
 * off-peak by the DeepSeek pricing rule, expanded from the State Council
 * notices:
 *
 * - 2025: 国办发明电〔2024〕12号 (2024-11-12) — 元旦 1/1, 春节 1/28-2/4,
 *   清明 4/4-4/6, 劳动节 5/1-5/5, 端午 5/31-6/2, 国庆+中秋 10/1-10/8.
 * - 2026: 国务院办公厅 2026 年部分节假日安排的通知 (2025-11-04) — 元旦 1/1-1/3,
 *   春节 2/15-2/23, 清明 4/4-4/6, 劳动节 5/1-5/5, 端午 6/19-6/21,
 *   中秋 9/25-9/27, 国庆 10/1-10/7.
 *
 * Make-up working weekends (调休上班) stay off-peak: the published rule keys
 * peak on Monday–Friday, not on the adjusted work calendar. Years not listed
 * here (and any holiday the notice moves) bill weekdays as peak — extend this
 * table when the State Council publishes the next arrangement, or pass the
 * extra dates through the `holidays` config field.
 */
export const CHINA_PUBLIC_HOLIDAYS: ReadonlySet<string> = new Set(chinaHolidayDates())

function chinaHolidayDates(): string[] {
  const ranges: readonly (readonly [string, string])[] = [
    ['2025-01-01', '2025-01-01'],
    ['2025-01-28', '2025-02-04'],
    ['2025-04-04', '2025-04-06'],
    ['2025-05-01', '2025-05-05'],
    ['2025-05-31', '2025-06-02'],
    ['2025-10-01', '2025-10-08'],
    ['2026-01-01', '2026-01-03'],
    ['2026-02-15', '2026-02-23'],
    ['2026-04-04', '2026-04-06'],
    ['2026-05-01', '2026-05-05'],
    ['2026-06-19', '2026-06-21'],
    ['2026-09-25', '2026-09-27'],
    ['2026-10-01', '2026-10-07'],
  ]
  const dates: string[] = []
  for (const [from, to] of ranges) {
    const end = Date.parse(`${to}T00:00:00Z`)
    for (let at = Date.parse(`${from}T00:00:00Z`); at <= end; at += 24 * 60 * 60 * 1000) {
      dates.push(new Date(at).toISOString().slice(0, 10))
    }
  }
  return dates
}

/**
 * Classify one request's billing period from its timestamp. Weekends and
 * Chinese public holidays are off-peak all day; on other days the two Beijing
 * peak windows bill at the peak rate.
 * @param timeMs - the request sample's epoch milliseconds.
 * @param holidays - extra holiday dates (`YYYY-MM-DD`) to honor, e.g. a moved
 * holiday or a year the bundled table predates.
 * @returns the period whose rates bill this sample.
 */
export function periodOf(timeMs: number, holidays?: readonly string[]): PricePeriod {
  const beijing = new Date(timeMs + BEIJING_OFFSET_MS)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) return 'offPeak'
  const month = `${beijing.getUTCMonth() + 1}`.padStart(2, '0')
  const day = `${beijing.getUTCDate()}`.padStart(2, '0')
  const date = `${beijing.getUTCFullYear()}-${month}-${day}`
  if (CHINA_PUBLIC_HOLIDAYS.has(date) || holidays?.includes(date) === true) return 'offPeak'
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to) ? 'peak' : 'offPeak'
}

const TIER_200K = 200_000
const TIER_272K = 272_000

/**
 * DeepSeek's own list prices (USD per 1M tokens), mirrored from
 * https://api-docs.deepseek.com/quick_start/pricing. Keyed by
 * `provider/model` for the harness's first-party adapter id, so the
 * provider-agnostic Zen rows below keep pricing Zen's routes for the same
 * model names.
 *
 * Peak hours — billed at the flat fields — are Beijing time Monday–Friday
 * 09:00–12:00 and 14:00–18:00, excluding Chinese public holidays (see
 * {@link CHINA_PUBLIC_HOLIDAYS}); everything else, including weekends and
 * holidays in full, bills the `offPeak` rates, which are exactly half.
 *
 * `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are retired model
 * names still accepted by the API and billed at the Flash price, hence the
 * identical rows. DeepSeek publishes no separate cache-write rate: cache
 * writes bill at the miss rate, which is what omitting `cacheWrite` does.
 */
export const DEEPSEEK_PRICES: PriceTable = {
  'deepseek-official/deepseek-flash': {
    input: 0.30,
    output: 1.20,
    cacheRead: 0.006,
    offPeak: { input: 0.15, output: 0.60, cacheRead: 0.003 },
  },
  'deepseek-official/deepseek-v4-flash': {
    input: 0.30,
    output: 1.20,
    cacheRead: 0.006,
    offPeak: { input: 0.15, output: 0.60, cacheRead: 0.003 },
  },
  'deepseek-official/deepseek-v4-flash-vision-exp': {
    input: 0.30,
    output: 1.20,
    cacheRead: 0.006,
    offPeak: { input: 0.15, output: 0.60, cacheRead: 0.003 },
  },
  'deepseek-official/deepseek-v4-pro': {
    input: 1.32,
    output: 3.96,
    cacheRead: 0.044,
    offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022 },
  },
}

/**
 * Bundled OpenCode Zen list prices (USD per 1M tokens), mirrored from
 * https://opencode.ai/docs/zen#pricing. Free model variants are included so
 * their usage is explicitly recognized at a zero rate. Tiered rows keep the lower-context rate in the flat fields and
 * the higher-context rate in `tiers`.
 */
export const ZEN_PRESETS: PriceTable = {
  'big-pickle': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'jev-1.13': { input: 0.042, output: 0 },
  'jev-1.13-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'ling-3.0-flash-fin-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'mimo-v2.6-flash-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'nemotron-3-ultra-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'nemotron-3.5-lightning-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'space-bunny-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
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
  'kimi-k2.5': { input: 0.60, output: 3.00, cacheRead: 0.08 },
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
  'claude-opus-5-5': { input: 4.00, output: 20.00, cacheRead: 0.20, cacheWrite: 5.00 },
  'claude-opus-4-8': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'claude-sonnet-5': { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
  'claude-sonnet-4': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
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
  'grok-4.7': { input: 1.40, output: 4.20, cacheRead: 0.35 },
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
  'muse-spark-1.3-contributor-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'muse-spark-1.2': { input: 1.25, output: 4.25, cacheRead: 0.15 },
  'muse-spark-1.2-contributor-free': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  'gpt-6-astra': {
    input: 10.00,
    output: 50.00,
    cacheRead: 1.00,
    cacheWrite: 12.50,
    tiers: [{ above: TIER_272K, input: 20.00, output: 75.00, cacheRead: 2.00, cacheWrite: 25.00 }],
  },
  'gpt-6-luna': { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-6-sol': { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
  'gpt-5.6-sol': {
    input: 4.00,
    output: 20.00,
    cacheRead: 0.40,
    cacheWrite: 5.00,
    tiers: [{ above: TIER_272K, input: 8.00, output: 30.00, cacheRead: 0.80, cacheWrite: 10.00 }],
  },
  'gpt-5.6-terra': { input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 3.125 },
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
 * The bundled price table: DeepSeek's first-party list prices plus the
 * OpenCode Zen catalog. Every entry is a published list price shipped with
 * the plugin; nothing here is user-configured.
 */
export const BUILTIN_PRICES: PriceTable = {
  ...DEEPSEEK_PRICES,
  ...ZEN_PRESETS,
}

/**
 * Format one micro-unit figure for display: fixed 4 decimals below 0.01,
 * 2 decimals from 100 up, adaptive in between.
 * @param micros - micro-unit cost.
 * @param currency - currency label (e.g. `USD`, `CNY`) or a literal symbol;
 * defaults to the bundled table's currency.
 * @returns display string such as `$0.0034`.
 */
export function formatCostMicros(micros: number, currency: string = PRICE_CURRENCY): string {
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

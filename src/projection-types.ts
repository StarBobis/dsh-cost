/**
 * Pure-type outlet of the dsh-cost session projection: the fold state and the
 * client view shapes plus their `SessionProjectionMap` /
 * `SessionProjectionStateMap` merges, importable from the browser bundle
 * without dragging the host-side cordis Context merges of the package root in
 * (the same split `@deepseek-ai/dsh-session-projection/types` documents).
 *
 * @module dsh-cost/projection-types
 */

import type { CostSplit, PricePeriod, TokenBuckets } from './pricing.ts'

/** Per-model cumulative fold state. All token buckets are disjoint. */
export interface CostModelState {
  provider: string
  model: string
  /** Settled request count (retry attempts collapse to one). */
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /**
   * The subset of the buckets above that was billed inside peak windows.
   * Zero for every model whose price has no off-peak row, and zero for a
   * model that simply saw no peak-time requests.
   */
  peak: TokenBuckets
  /**
   * Fold-time billed cost in micro-units, accumulated only while the matched
   * price declares tiers; flat-rate models leave this at 0 and price from the
   * buckets in the view.
   */
  tieredMicros: number
  /**
   * Per-bucket split of `tieredMicros`. Optional: states folded before this
   * field existed carry only the total, and their view rows report a null
   * split. Its parts sum exactly to `tieredMicros`.
   */
  tieredSplit?: CostSplit
}

/** The replacement slot for one (turn, step)'s latest usage sample. */
export interface CostLastSample {
  turn: number
  step: number
  /** Model accumulator key the sample was added to. */
  key: string
  buckets: TokenBuckets
  tieredMicros: number
  /** Per-bucket split of the sample's `tieredMicros` (absent on legacy folds). */
  tieredSplit?: CostSplit
  /** Billing period the sample was folded under, so a restatement reverts the same buckets. */
  period: PricePeriod
}

/** Whole-session fold state; plain JSON for the persisted projection cache. */
export interface CostState {
  /** Per-model accumulators keyed by `provider/model`. */
  models: Record<string, CostModelState>
  /** The route of the latest `request/header`; usage attaches to it. */
  current: { provider: string, model: string } | null
  /** Latest usage sample, replaceable while the same (turn, step) restates it. */
  last: CostLastSample | null
}

/** One model's row in the client view. */
export interface CostModelBreakdown extends TokenBuckets {
  /** Accumulator key, `provider/model`. */
  key: string
  provider: string
  model: string
  requests: number
  /** The peak-window subset of the buckets above (all zero for single-rate models). */
  peak: TokenBuckets
  /** Micro-unit cost of this model, or null when no price is configured. */
  costMicros: number | null
  /**
   * Cost of the peak subset, or null when the model has no off-peak row (its
   * whole cost already bills at one rate). `peakMicros + offPeakMicros` equals
   * `costMicros` whenever both are present.
   */
  peakMicros: number | null
  /** Cost of the part billed off-peak; null exactly when `peakMicros` is. */
  offPeakMicros: number | null
  /**
   * Per-bucket split of the fold-time billed cost, present only on tiered
   * rows whose state was folded with split tracking. Flat-rate rows carry
   * null here — their split is computed from the buckets against the live
   * table — and so do legacy tiered folds, which only know their total.
   */
  tieredSplitMicros: CostSplit | null
  /**
   * True when the matched price bills per-request tiers: `costMicros` is the
   * fold-time accumulation and does not move with later price edits.
   */
  tiered: boolean
}

/** The client-visible whole-session cost value. */
export interface CostProjection {
  /** Currency label from the plugin configuration (preset prices are USD). */
  currency: string
  /** Sum of priced models' `costMicros`. */
  totalMicros: number
  /** Per-model rows in first-seen order. */
  models: CostModelBreakdown[]
  /** `provider/model` keys with usage but no configured price. */
  unpriced: string[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Session cost priced against the configured table. */
    cost: CostProjection
  }
  interface SessionProjectionStateMap {
    /** dsh-cost fold state: per-model token buckets plus tier-billed cost. */
    cost: CostState
  }
}

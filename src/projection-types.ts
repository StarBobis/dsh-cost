/**
 * Pure-type outlet of the dsh-cost session projection: the fold state and the
 * client view shapes plus their `SessionProjectionMap` /
 * `SessionProjectionStateMap` merges, importable from the browser bundle
 * without dragging the host-side cordis Context merges of the package root in
 * (the same split `@deepseek-ai/dsh-session-projection/types` documents).
 *
 * @module dsh-cost/projection-types
 */

import type { TokenBuckets } from './pricing.ts'

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
   * Fold-time billed cost in micro-units, accumulated only while the matched
   * price declares tiers; flat-rate models leave this at 0 and price from the
   * buckets in the view.
   */
  tieredMicros: number
}

/** The replacement slot for one (turn, step)'s latest usage sample. */
export interface CostLastSample {
  turn: number
  step: number
  /** Model accumulator key the sample was added to. */
  key: string
  buckets: TokenBuckets
  tieredMicros: number
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
  /** Micro-unit cost of this model, or null when no price is configured. */
  costMicros: number | null
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

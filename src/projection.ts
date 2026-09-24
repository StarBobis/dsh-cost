/**
 * Host side of the cost projection: a replayed per-session fold of
 * provider-reported usage into per-model token buckets, with a client view
 * that prices those buckets against the plugin's bundled price table.
 *
 * The state carries only session facts (tokens, request counts, the peak
 * share of those tokens, and the fold-time accumulation of tier-billed
 * requests), never prices, so persisted projection-cache rows survive plugin
 * updates and price changes. Flat-rate models are priced in the view from the
 * live table; tiered models accumulate at fold time because the tier is
 * selected by each request's own billed input; prices with an off-peak row
 * are billed by request time, so the fold records how much of each bucket
 * happened inside a peak window.
 *
 * @module dsh-cost/projection
 */

import { z } from 'zod'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import {
  bucketsCostMicros,
  hasOffPeak,
  periodOf,
  PRICE_CURRENCY,
  resolvePrice,
  subtractBuckets,
  usageCostSplitMicros,
  ZERO_BUCKETS,
  type CostSplit,
  type PricePeriod,
  type ResolvedPrices,
  type TokenBuckets,
} from './pricing.ts'
import type {
  CostModelBreakdown,
  CostModelState,
  CostProjection,
  CostState,
} from './projection-types.ts'

export type {
  CostLastSample,
  CostModelBreakdown,
  CostModelState,
  CostProjection,
  CostState,
} from './projection-types.ts'

const bucketsSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
}).strict()

/** Per-bucket micro-unit split; optional on state rows folded before it existed. */
const splitSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
}).strict()

/**
 * Split schema for the FOLD STATE, which additionally tolerates the derived
 * `total` key. Every sample split is computed by `usageCostSplitMicros` and
 * therefore carries `total`; storing it was never intended (the state keeps
 * buckets, the total is re-derived), but rows written while it leaked in must
 * keep parsing: a strict schema rejected them, and a rejected row makes the
 * whole projection-cache restore/listing path drop or throw for that session,
 * so the session could never be counted at all. Writes below strip it.
 */
const stateSplitSchema = splitSchema.extend({
  total: z.number().int().nonnegative().optional(),
}).strict()

const stateSchema = z.object({
  models: z.record(z.string(), bucketsSchema.extend({
    provider: z.string(),
    model: z.string(),
    requests: z.number().int().nonnegative(),
    /** Peak-window subset of the buckets; every v3 fold writes it. */
    peak: bucketsSchema,
    tieredMicros: z.number().int().nonnegative(),
    tieredSplit: stateSplitSchema.optional(),
  }).strict()),
  current: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    key: z.string(),
    buckets: bucketsSchema,
    tieredMicros: z.number().int().nonnegative(),
    tieredSplit: stateSplitSchema.optional(),
    period: z.enum(['peak', 'offPeak']),
  }).strict().nullable(),
}).strict()

const viewSchema = z.object({
  currency: z.string(),
  totalMicros: z.number().int().nonnegative(),
  models: z.array(bucketsSchema.extend({
    key: z.string(),
    provider: z.string(),
    model: z.string(),
    requests: z.number().int().nonnegative(),
    peak: bucketsSchema,
    costMicros: z.number().int().nonnegative().nullable(),
    peakMicros: z.number().int().nonnegative().nullable(),
    offPeakMicros: z.number().int().nonnegative().nullable(),
    tieredSplitMicros: splitSchema.nullable(),
    tiered: z.boolean(),
  }).strict()),
  unpriced: z.array(z.string()),
}).strict()

const zeroBuckets = (): TokenBuckets => ({ ...ZERO_BUCKETS })

const bucketsFromUsage = (usage: TokenUsage): TokenBuckets => ({
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cacheReadTokens: usage.cacheReadTokens ?? 0,
  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
})

const bucketsEqual = (left: TokenBuckets, right: TokenBuckets): boolean =>
  left.inputTokens === right.inputTokens
  && left.outputTokens === right.outputTokens
  && left.cacheReadTokens === right.cacheReadTokens
  && left.cacheWriteTokens === right.cacheWriteTokens

const addBuckets = (into: TokenBuckets, delta: TokenBuckets, sign: 1 | -1): void => {
  into.inputTokens += sign * delta.inputTokens
  into.outputTokens += sign * delta.outputTokens
  into.cacheReadTokens += sign * delta.cacheReadTokens
  into.cacheWriteTokens += sign * delta.cacheWriteTokens
}

const addSplit = (into: CostSplit, delta: CostSplit, sign: 1 | -1): void => {
  into.input += sign * delta.input
  into.output += sign * delta.output
  into.cacheRead += sign * delta.cacheRead
  into.cacheWrite += sign * delta.cacheWrite
}

/** The usage one durable assistant settlement reports for its attempt, if any. */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

const modelKey = (provider: string, model: string): string => `${provider}/${model}`

/**
 * The buckets-only share of a computed split. State rows store buckets and
 * re-derive every total, so any extra key a computed split carries (the
 * `total` of a `CostSplitTotal`, or one that leaked into a legacy state row)
 * must never reach a state row or a wire value.
 */
const splitBuckets = (split: CostSplit): CostSplit => ({
  input: split.input,
  output: split.output,
  cacheRead: split.cacheRead,
  cacheWrite: split.cacheWrite,
})

/**
 * The registration shape `ctx.sessionProjections.register` requires for a
 * client-visible unit: the optional `wire` block made non-nullable.
 */
export type CostProjectionDefinition = Omit<ProjectionDefinition<'cost', CostState>, 'wire'> & {
  wire: NonNullable<ProjectionDefinition<'cost', CostState>['wire']>
}

/**
 * Build the cost projection unit bound to one price source.
 * @param prices - thunk resolving the currently configured prices; read at
 * fold time (tier billing) and at view time (flat billing).
 * @returns the projection definition to register with `ctx.sessionProjections`.
 */
export function costProjectionDefinition(
  prices: () => ResolvedPrices,
): CostProjectionDefinition {
  // View memoization: the drive suppresses publication on Object.is, so the
  // view must reuse its reference until the state or the price table moves.
  let lastState: CostState | undefined
  let lastPrices: ResolvedPrices | undefined
  let lastView: CostProjection | undefined

  return {
    key: 'cost',
    // v2: grok-4.7 joined the preset table as a tiered row; requests folded
    // while it was unpriced cached tieredMicros=0, so cached v1 states must
    // re-fold to bill them.
    // v3: the bundled DeepSeek rows bill by request time, so each model
    // records the peak-window share of its buckets; a v2 row has no such
    // split and would bill every token at one rate, so it must re-fold.
    stateVersion: 3,
    stateSchema,
    init: () => ({ models: {}, current: null, last: null }),
    apply: (state, event) => {
      if (event.type === 'request/header') {
        const { provider, model } = event.data.header.config
        if (state.current?.provider === provider && state.current.model === model) return state
        return { ...state, current: { provider, model } }
      }
      if (event.type === 'llm/retry-started') {
        return state.last?.turn === event.data.turn && state.last.step === event.data.step
          ? { ...state, last: null }
          : state
      }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
      const usage = usageOf(event)
      if (usage === undefined || state.current === null) return state
      const { turn, step } = event.data
      const { provider, model } = state.current
      const key = modelKey(provider, model)
      const buckets = bucketsFromUsage(usage)
      const resolved = prices()
      const price = resolvePrice(resolved.table, provider, model)
      // The sample's own timestamp decides peak vs off-peak; a request that
      // straddles a window boundary bills the period it settled in.
      const period: PricePeriod = periodOf(event.time, resolved.holidays)
      // Tiered billing happens per request at fold time; the split's total is
      // the sample's billed cost and the parts feed the per-bucket breakdown.
      const tieredSplit = price?.tiers !== undefined && price.tiers.length > 0
        ? usageCostSplitMicros(price, buckets, period)
        : undefined
      const tieredMicros = tieredSplit?.total ?? 0
      // `tieredMicros` already carries the derived total; the state stores buckets.
      const sample = tieredSplit === undefined ? undefined : splitBuckets(tieredSplit)

      const models: Record<string, CostModelState> = { ...state.models }
      // A same-(turn, step) sample REPLACES the previous one (stream restatement);
      // `llm/retry-started` closes the slot so a retried attempt bills again.
      const last = state.last
      if (last !== null && last.turn === turn && last.step === step) {
        if (last.key === key && bucketsEqual(last.buckets, buckets)) return state
        const previous = models[last.key]
        if (previous !== undefined) {
          // `peak` is an object, so it must be copied before it is mutated:
          // spreading the entry alone would alias the previous state's buckets.
          const reverted = { ...previous, requests: previous.requests - 1, peak: { ...previous.peak } }
          addBuckets(reverted, last.buckets, -1)
          if (last.period === 'peak') addBuckets(reverted.peak, last.buckets, -1)
          reverted.tieredMicros -= last.tieredMicros
          if (last.tieredSplit === undefined) {
            // A legacy sample carries no split: the remaining total's split is
            // unknowable, so the row drops its breakdown rather than mis-sum.
            delete reverted.tieredSplit
          } else if (reverted.tieredSplit !== undefined) {
            addSplit(reverted.tieredSplit, last.tieredSplit, -1)
          }
          models[last.key] = reverted
        }
      }
      const entry = models[key] ?? {
        provider,
        model,
        requests: 0,
        ...zeroBuckets(),
        peak: zeroBuckets(),
        tieredMicros: 0,
      }
      // Same copy-before-mutate rule as the revert path above.
      const next = { ...entry, requests: entry.requests + 1, peak: { ...entry.peak } }
      addBuckets(next, buckets, 1)
      if (period === 'peak') addBuckets(next.peak, buckets, 1)
      if (sample !== undefined) {
        // Split tracking starts clean from a zero total; a legacy
        // (split-less) tiered remainder taints the row permanently.
        next.tieredSplit = next.tieredMicros === 0
          ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          : next.tieredSplit
        if (next.tieredSplit !== undefined) addSplit(next.tieredSplit, sample, 1)
      }
      next.tieredMicros += tieredMicros
      models[key] = next

      return {
        models,
        current: state.current,
        last: {
          turn,
          step,
          key,
          buckets,
          tieredMicros,
          period,
          ...sample === undefined ? {} : { tieredSplit: sample },
        },
      }
    },
    wire: {
      viewSchema,
      view: (state) => {
        const resolved = prices()
        if (lastView !== undefined && lastState === state && lastPrices === resolved) return lastView
        const models: CostModelBreakdown[] = []
        const unpriced: string[] = []
        let totalMicros = 0
        for (const [key, entry] of Object.entries(state.models)) {
          const price = resolvePrice(resolved.table, entry.provider, entry.model)
          const peak = entry.peak
          const row = {
            key,
            provider: entry.provider,
            model: entry.model,
            requests: entry.requests,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            cacheReadTokens: entry.cacheReadTokens,
            cacheWriteTokens: entry.cacheWriteTokens,
            peak: { ...peak },
            costMicros: null as number | null,
            peakMicros: null as number | null,
            offPeakMicros: null as number | null,
            tieredSplitMicros: null as CostSplit | null,
            tiered: false,
          }
          if (price === undefined) {
            unpriced.push(key)
            models.push(row)
            continue
          }
          row.tiered = price.tiers !== undefined && price.tiers.length > 0
          if (row.tiered) {
            row.costMicros = entry.tieredMicros
            // Copied key by key: a row written while the derived `total` leaked
            // into the state would otherwise fail the strict view schema, which
            // the registry parses outside its own containment.
            row.tieredSplitMicros = entry.tieredSplit === undefined
              ? null
              : splitBuckets(entry.tieredSplit)
          } else if (!hasOffPeak(price)) {
            row.costMicros = bucketsCostMicros(price, entry)
          } else {
            // Published both periods' rates: bill each part at its own rate.
            row.peakMicros = bucketsCostMicros(price, peak, 'peak')
            row.offPeakMicros = bucketsCostMicros(price, subtractBuckets(entry, peak), 'offPeak')
            row.costMicros = row.peakMicros + row.offPeakMicros
          }
          totalMicros += row.costMicros
          models.push(row)
        }
        lastState = state
        lastPrices = resolved
        lastView = { currency: PRICE_CURRENCY, totalMicros, models, unpriced }
        return lastView
      },
    },
  }
}

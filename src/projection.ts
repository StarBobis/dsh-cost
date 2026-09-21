/**
 * Host side of the cost projection: a replayed per-session fold of
 * provider-reported usage into per-model token buckets, with a client view
 * that prices those buckets against the currently configured table.
 *
 * The state carries only session facts (tokens, request counts, and the
 * fold-time accumulation of tier-billed requests), never prices, so persisted
 * projection-cache rows survive price edits. Flat-rate models are priced in
 * the view from the live table; tiered models accumulate at fold time because
 * the tier is selected by each request's own billed input.
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
  resolvePrice,
  usageCostMicros,
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

const stateSchema = z.object({
  models: z.record(z.string(), bucketsSchema.extend({
    provider: z.string(),
    model: z.string(),
    requests: z.number().int().nonnegative(),
    tieredMicros: z.number().int().nonnegative(),
  }).strict()),
  current: z.object({ provider: z.string(), model: z.string() }).strict().nullable(),
  last: z.object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    key: z.string(),
    buckets: bucketsSchema,
    tieredMicros: z.number().int().nonnegative(),
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
    costMicros: z.number().int().nonnegative().nullable(),
    tiered: z.boolean(),
  }).strict()),
  unpriced: z.array(z.string()),
}).strict()

const zeroBuckets = (): TokenBuckets => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

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

/** The usage one durable assistant settlement reports for its attempt, if any. */
function usageOf(event: SessionEvent): TokenUsage | undefined {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

const modelKey = (provider: string, model: string): string => `${provider}/${model}`

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
    stateVersion: 1,
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
      const price = resolvePrice(prices().table, provider, model)
      const tieredMicros = price?.tiers !== undefined && price.tiers.length > 0
        ? usageCostMicros(price, buckets)
        : 0

      const models: Record<string, CostModelState> = { ...state.models }
      // A same-(turn, step) sample REPLACES the previous one (stream restatement);
      // `llm/retry-started` closes the slot so a retried attempt bills again.
      const last = state.last
      if (last !== null && last.turn === turn && last.step === step) {
        if (last.key === key && bucketsEqual(last.buckets, buckets)) return state
        const previous = models[last.key]
        if (previous !== undefined) {
          const reverted = { ...previous, requests: previous.requests - 1 }
          addBuckets(reverted, last.buckets, -1)
          reverted.tieredMicros -= last.tieredMicros
          models[last.key] = reverted
        }
      }
      const entry = models[key] ?? {
        provider,
        model,
        requests: 0,
        ...zeroBuckets(),
        tieredMicros: 0,
      }
      const next = { ...entry, requests: entry.requests + 1 }
      addBuckets(next, buckets, 1)
      next.tieredMicros += tieredMicros
      models[key] = next

      return {
        models,
        current: state.current,
        last: { turn, step, key, buckets, tieredMicros },
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
          const row = {
            key,
            provider: entry.provider,
            model: entry.model,
            requests: entry.requests,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            cacheReadTokens: entry.cacheReadTokens,
            cacheWriteTokens: entry.cacheWriteTokens,
            costMicros: null as number | null,
            tiered: false,
          }
          if (price === undefined) {
            unpriced.push(key)
            models.push(row)
            continue
          }
          row.tiered = price.tiers !== undefined && price.tiers.length > 0
          row.costMicros = row.tiered ? entry.tieredMicros : bucketsCostMicros(price, entry)
          totalMicros += row.costMicros
          models.push(row)
        }
        lastState = state
        lastPrices = resolved
        lastView = { currency: resolved.currency, totalMicros, models, unpriced }
        return lastView
      },
    },
  }
}

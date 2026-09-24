/**
 * Cost history backfill: fold every persisted session that has no usable
 * projection checkpoint yet, so the settings card covers the whole corpus —
 * archived sessions and sessions that predate the plugin included — instead
 * of only the ones opened since installation.
 *
 * The sweep rides the framework's own cold-read recipe: each uncached
 * session is read once through `sessionQuery.readSession` and folded by
 * `sessionProjectionCache.coldSnapshot`, whose write-back makes the result
 * durable, so the sweep is a one-time cost and resumes across restarts.
 *
 * Two pacing modes share one single-flight loop:
 *
 * - background: starts deferred after boot and sleeps between sessions, so
 *   the host stays responsive while history trickles in on its own;
 * - immediate: the web client's refresh button calls the `dshCost/backfill`
 *   Remote, which starts the sweep right away (or boosts the running one by
 *   dropping its sleeps) and folds with a small read concurrency, so the
 *   full history lands in one click instead of minutes of background crawl.
 *
 * Checkpoint identity includes the fork-inherited prefix length, which a
 * listed header does not carry: non-seeded sessions are pre-checked through
 * the zero-I/O cached view, while seeded (forked) ones are read first and
 * then pre-checked with their exact prefix length before folding.
 *
 * @module dsh-cost/backfill
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionLogOffset } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-query'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { BackfillReport } from './backfill-report.ts'

export type { BackfillReport } from './backfill-report.ts'

/** Startup grace before the background sweep begins, so boot work settles first (ms). */
const START_DELAY_MS = 5_000
/** Pause between sessions in background mode (ms): the fold is synchronous, so let I/O breathe. */
const YIELD_MS = 40
/** Concurrent cold reads when the client asked for an immediate sweep. */
const IMMEDIATE_CONCURRENCY = 8

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Single-flight sweep owner. At most one loop runs at a time; `runNow`
 * joins a running loop after switching it to full speed, or starts an
 * unpaced one when idle.
 */
export class CostBackfill {
  private sweep: Promise<BackfillReport> | null = null
  private concurrent = false
  private boosted = false
  private disposed = false

  /**
   * @param ctx - plugin context (host).
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Arm the deferred background sweep; the returned teardown cancels it.
   * Sessions already carrying a usable `cost` checkpoint are skipped; live
   * sessions checkpoint themselves through the normal write path.
   * @returns effect disposer.
   */
  startBackground(): () => Promise<void> {
    const timer = setTimeout(() => {
      this.run(false).catch((error: unknown) => {
        this.ctx.logger.error(`dsh-cost: history backfill aborted: ${String(error)}`)
      })
    }, START_DELAY_MS)
    return async () => {
      this.disposed = true
      clearTimeout(timer)
      await this.sweep?.catch(() => {})
    }
  }

  /**
   * Run the sweep now at full speed, joining (and boosting) a running one.
   * @returns the sweep's report once every listed session has a checkpoint or a failure.
   */
  runNow(): Promise<BackfillReport> {
    if (this.disposed) return Promise.resolve({ total: 0, folded: 0, failed: 0 })
    return this.run(true)
  }

  private run(immediate: boolean): Promise<BackfillReport> {
    if (immediate) this.boosted = true
    if (this.sweep !== null) return this.sweep
    this.concurrent = immediate
    const sweep = this.sweepAll()
    const settled = sweep.then(
      report => report,
      (error: unknown) => {
        // Error level, not warn: the default logger threshold drops `warn`, so
        // a fatal sweep would otherwise fail in complete silence.
        this.ctx.logger.error(`dsh-cost: history backfill aborted: ${String(error)}`)
        return { total: 0, folded: 0, failed: 0 }
      },
    )
    this.sweep = settled
    void settled.then(() => {
      if (this.sweep === settled) {
        this.sweep = null
        this.boosted = false
        this.concurrent = false
      }
    })
    return settled
  }

  private async sweepAll(): Promise<BackfillReport> {
    const cache = this.ctx.get('sessionProjectionCache')
    const query = this.ctx.get('sessionQuery')
    if (cache === undefined || query === undefined) return { total: 0, folded: 0, failed: 0 }
    const records = await query.listSessions()
    // Invisible in the session list (no cwd) or live (checkpoints itself).
    const headers = records
      .filter(record => record.header.cwd !== undefined && !record.live)
      .map(record => record.header)
    const report: BackfillReport = { total: headers.length, folded: 0, failed: 0 }
    /** First per-session failure, surfaced in the sweep summary for diagnosis. */
    let firstFailure: string | undefined
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (!this.disposed) {
        const header = headers[cursor]
        cursor += 1
        if (header === undefined) return
        try {
          // Zero-I/O pre-check for the common non-seeded case; seeded sessions
          // need their log's exact inherited prefix length for the identity.
          if (!header.isSeeded) {
            const cached = cache.cachedSnapshot(header, SessionLogOffset(0), ['cost'])
            if (cached?.values.cost !== undefined) continue
          }
          const loaded = await query.readSession(header.id)
          if (this.disposed) return
          // Went live while reading: the live write path owns it now.
          // `ctx.get`, not `ctx.sessions`: a plain service read demands an
          // `inject` entry on the plugin fiber and throws otherwise, exactly
          // like the two optional lookups above.
          if (this.ctx.get('sessions')?.get(header.id) !== undefined) continue
          if (header.isSeeded) {
            const cached = cache.cachedSnapshot(loaded.session, loaded.inheritedEventCount, ['cost'])
            if (cached?.values.cost !== undefined) continue
          }
          cache.coldSnapshot(loaded.session, loaded.inheritedEventCount, loaded.events)
          report.folded += 1
          if (report.folded % 25 === 0) {
            this.ctx.logger.info(`dsh-cost: history backfill folded ${String(report.folded)} sessions so far`)
          }
        } catch (error) {
          report.failed += 1
          firstFailure ??= `${header.id}: ${String(error)}`
          this.ctx.logger.warn(`dsh-cost: backfill skipped session "${header.id}": ${String(error)}`)
        }
        if (!this.boosted) await sleep(YIELD_MS)
      }
    }
    const lanes = this.concurrent ? Math.min(IMMEDIATE_CONCURRENCY, headers.length) : 1
    await Promise.all(Array.from({ length: lanes }, () => worker()))
    // One self-reporting summary per sweep. Per-session failures go to `warn`,
    // which the default logger threshold drops from its buffer, and the client
    // only ever receives the report counts — so this info line is the sweep's
    // own record of what happened, next to the fold-progress lines above.
    if (report.folded > 0 || report.failed > 0) {
      this.ctx.logger.info(
        `dsh-cost: history backfill finished: folded ${String(report.folded)}, failed ${String(report.failed)}, listed ${String(report.total)}`
        + (firstFailure === undefined ? '' : `; first failure ${firstFailure}`),
      )
    }
    return report
  }
}

/**
 * Host Remote exposing the on-demand sweep to the web client. The Typert
 * Gateway discovers the `typertRemote` binding on this service and derives
 * the wire contract from the decorated method's signature (SRC mode), so no
 * generated host descriptor is needed; the client mounts the matching
 * hand-written contribution from `client/remote.ts`.
 */
export class CostBackfillService extends TypertRemoteService {
  /**
   * @param ctx - plugin context (host).
   * @param backfill - the shared sweep owner.
   */
  constructor(ctx: Context, private readonly backfill: CostBackfill) {
    super(ctx, 'dshCost')
  }

  /**
   * Fold every un-checkpointed session now; the client re-pulls the session
   * list once this resolves.
   * @returns the sweep report.
   */
  @Remote('backfill')
  backfillNow(): Promise<BackfillReport> {
    return this.backfill.runNow()
  }
}

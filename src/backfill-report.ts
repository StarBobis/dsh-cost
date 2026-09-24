/**
 * The `dshCost/backfill` Remote result, shared by the host sweep
 * (`backfill.ts`) and the client contribution (`client/remote.ts`). Kept
 * dependency-free so both the host and the browser type programs can import
 * it without dragging either side's Context augmentations along.
 *
 * @module dsh-cost/backfill-report
 */

/** Outcome of one history backfill sweep. */
export interface BackfillReport {
  /** Billable (listed, non-live) sessions the sweep inspected. */
  total: number
  /** Sessions folded to a durable cost checkpoint by this sweep. */
  folded: number
  /** Sessions that still lack a checkpoint because reading or folding failed. */
  failed: number
}

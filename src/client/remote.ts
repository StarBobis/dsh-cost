/**
 * Hand-written Typert Remote contribution matching the host's `dshCost`
 * service (`src/backfill.ts`). The host gateway derives its side from the
 * decorated method's signature (SRC mode); this client-side descriptor only
 * needs to agree on the endpoint and carry no parameters — the zero-argument
 * call validates no fields, so no runtime schema is bundled for it.
 */

import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { BackfillReport } from '../backfill-report.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    /** Host `dshCost` service: on-demand cost-history backfill. */
    dshCost: CostBackfillRemote
  }
}

/** Typed face of the host `dshCost` Remote namespace. */
export interface CostBackfillRemote {
  /** Fold every un-checkpointed session now; resolves with the sweep report. */
  backfill: () => Promise<RemoteResult<BackfillReport>>
}

/** The contribution mounted through `ctx.remote.$mount` at plugin start. */
export const COST_REMOTE: TypertRemoteContribution = {
  package: 'dsh-cost',
  descriptors: [{
    id: 'dsh-cost#dshCost/backfill',
    service: 'dshCost',
    namespace: 'dshCost',
    method: 'backfill',
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'src-json' },
  }],
}

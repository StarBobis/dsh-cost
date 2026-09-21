/**
 * dsh-cost browser half: registers the composer-dock cost pill and the
 * `dsh-cost` settings card. Cost math rides the host-computed `cost`
 * projection; the price table rides the client settings mirror, so edits
 * reprice the UI immediately.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: ctx.locale Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: ctx.slots Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the dock slot and session/global standard-kit merges.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the keyed plugin-card slot merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only: the `cost` SessionProjectionMap merge for useProjection.
import type {} from '../projection-types.ts'
import { CostCard, type CostCardInjected } from './CostCard.tsx'
import { CostPill, type CostPillInjected } from './CostPill.tsx'
import { COST_NS, CostSettingsController } from './controller.ts'
import type { Config } from '../config.ts'
import { en, NS, zh } from './locales.ts'

export type { CostSettingsController, CostSettingsSnapshot } from './controller.ts'
export type { CostPillInjected, CostPillProps } from './CostPill.tsx'
export type { CostCardInjected, CostCardProps } from './CostCard.tsx'
export type { CostKey } from './locales.ts'

/** Required client services: slot registry, locale, settings mirror, session list. */
export const inject = ['slots', 'locale', 'settingsScope', 'sessions']

/**
 * Mount the cost UI.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cost: dictionaries')

  const controller = new CostSettingsController(ctx.settingsScope.bind<Config>({ namespace: COST_NS }))

  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'cost',
      order: 10,
      locale: NS,
      inject: (): CostPillInjected => ({
        hooks: { costSettings: controller.store },
      }),
    }, CostPill))

  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register({
      name: 'settings.plugin.item',
      key: COST_NS,
      locale: NS,
      inject: (): CostCardInjected => ({
        hooks: { costSettings: controller.store },
        save: input => controller.save(input),
        resetAll: () => controller.resetAll(),
        openSession: (sessionId: SessionId) => { ctx.sessions.open(sessionId) },
      }),
    }, CostCard))
}

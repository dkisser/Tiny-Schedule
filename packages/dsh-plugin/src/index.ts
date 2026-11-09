/**
 * dsh-plugin-tiny-schedule — host half.
 *
 * Opens the `task_tracker` storage domain, publishes the agent tools, and
 * serves the browser's JSON endpoint. The browser half ships separately
 * through `exports["./client"]`.
 */
import type { Context } from '@deepseek-ai/cordis';
import { registerHttpRoutes } from './http.ts';
import { TaskTrackerService } from './service/service.ts';
import { taskTrackerDomainSpec } from './service/spec.ts';
import { registerTools } from './tools/index.ts';

/** Plugin name — the loader row id and the browser bundle id. */
export const name = 'dsh-plugin-tiny-schedule';

/** Required host services: the storage domain facility, the tool registry, the web server. */
export const inject = ['storageDomain', 'tools', 'webServer'];

/**
 * Plugin body.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(taskTrackerDomainSpec);
    const service = new TaskTrackerService(domain);
    // Tools first: a tool the harness refuses must fail the whole plugin,
    // not leave a half-working surface behind.
    const tools = registerTools(ctx, service);
    const unregisterRoutes = registerHttpRoutes(ctx, service, tools);
    ctx.logger.info(
      `dsh-plugin-tiny-schedule: registered ${tools.names.length} tools (${tools.names.join(', ')})`,
    );
    return async () => {
      tools.dispose();
      unregisterRoutes();
      await domain.close();
    };
  }, 'tiny-schedule: bootstrap');
}

export type { TrackerSnapshot } from './service/service.ts';
export { TaskTrackerService } from './service/service.ts';
export { taskTrackerDomainSpec } from './service/spec.ts';

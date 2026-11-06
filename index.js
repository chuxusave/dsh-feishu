/**
 * dsh-feishu — Feishu/Lark tools for DeepSeek Harness.
 *
 * The bundle registers Host tools that shell out to the official `lark-cli`
 * (npm: `@larksuite/cli`) and a loopback settings API for its Web settings
 * page. Authentication, token refresh and permission handling stay in
 * lark-cli, so this plugin stores no credentials.
 *
 * @module dsh-feishu
 */

import { buildRuntime } from './cli.js'
import { registerRoutes } from './routes.js'
import { loadSettings, saveSettings } from './settings.js'
import { buildBaseTools } from './tools-base.js'
import { buildCalendarTools } from './tools-calendar.js'
import { buildApprovalTools } from './tools-approval.js'
import { buildMessagingTools } from './tools-messaging.js'
import { buildSheetsTools } from './tools-sheets.js'
import { buildTaskTools } from './tools-tasks.js'

/** Bundle version reported to the settings page. */
const VERSION = '0.4.0'

/** Bundle row name; must match `package.json` `name`. */
export const name = 'dsh-feishu'

/** The tool registry and the Web carrier are both required. */
export const inject = ['tools', 'webServer']

/**
 * Bundle entry point.
 *
 * @param {any} ctx - the plugin context.
 */
export function apply(ctx) {
  const state = {
    settings: loadSettings(),
    runtime: null,
    disposers: [],
  }

  /** Rebuild the tool set for the current settings and return its size. */
  const rebuild = () => {
    for (const dispose of state.disposers.splice(0)) dispose()
    state.runtime = buildRuntime(state.settings)
    const definitions = [
      ...buildMessagingTools(state.runtime, state.settings),
      ...buildBaseTools(state.runtime, state.settings),
      ...buildCalendarTools(state.runtime, state.settings),
      ...buildSheetsTools(state.runtime, state.settings),
      ...buildTaskTools(state.runtime, state.settings),
      ...buildApprovalTools(state.runtime, state.settings),
    ]
    for (const definition of definitions) state.disposers.push(ctx.tools.register(definition))
    return definitions.length
  }

  ctx.effect(() => {
    rebuild()
    return () => {
      for (const dispose of state.disposers.splice(0)) dispose()
    }
  })

  ctx.effect(() => {
    const disposers = registerRoutes(ctx, {
      version: VERSION,
      settings: () => state.settings,
      runtime: () => state.runtime,
      tools: () => state.disposers.length,
      clientModules: () => ctx.get('clientModules'),
      reload: (patch) => {
        state.settings = saveSettings(patch)
        rebuild()
        return state.settings
      },
    })
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}

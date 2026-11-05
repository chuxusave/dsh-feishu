/**
 * Loopback-fenced HTTP routes backing the settings page.
 *
 * The settings page is a browser module, so it talks to these routes rather
 * than to tool RPC. Every handler refuses non-loopback callers and cross-site
 * browser requests: the routes expose the local CLI path and let the page
 * change write behaviour.
 *
 * @module dsh-feishu/routes
 */

import { resolveCli, runCli } from './cli.js'
import { settingsPath } from './settings.js'

/** Route prefix of the Feishu settings API. */
export const FEISHU_API_PREFIX = '/api/dsh-feishu'

/** Cap on JSON request bodies (tiny settings payloads only). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/**
 * Loopback literal check plus browser same-origin markers.
 *
 * @param {import('node:http').IncomingMessage} request - incoming request.
 */
function isLoopbackRequest(request) {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Write one JSON response. */
function writeJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

/** Read and parse a bounded JSON request body. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_JSON_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    request.on('error', reject)
  })
}

/** Run one `lark-cli doctor` and normalize its checks for the UI. */
async function doctorSnapshot(runtime) {
  const resolved = resolveCli(runtime)
  try {
    const raw = await runCli(runtime, ['doctor'], undefined)
    const parsed = JSON.parse(raw.stdout.trim())
    const checks = Array.isArray(parsed.checks) ? parsed.checks : []
    const state = (id) => {
      const check = checks.find((item) => item && item.name === id)
      return check ? String(check.status ?? 'unknown') : 'unknown'
    }
    return {
      ok: parsed.ok === true,
      bot: state('bot_identity'),
      user: state('user_identity'),
      api: state('endpoint_open'),
      path: runtime.larkCliPath,
      resolved,
      message: '',
    }
  } catch (error) {
    return {
      ok: false,
      bot: 'unknown',
      user: 'unknown',
      api: 'unknown',
      path: runtime.larkCliPath,
      resolved,
      message: String(error?.message ?? error),
    }
  }
}

/**
 * Register the settings routes.
 *
 * @param {any} ctx - plugin context carrying `webServer`.
 * @param {{
 *   version: string,
 *   settings: () => Record<string, unknown>,
 *   runtime: () => any,
 *   tools: () => number,
 *   reload: (patch: Record<string, unknown>) => Record<string, unknown>,
 * }} hooks - accessors shared with the Host entry.
 * @returns {Array<() => void>} route disposers.
 */
export function registerRoutes(ctx, hooks) {
  const routes = [
    {
      kind: 'exact',
      path: `${FEISHU_API_PREFIX}/status`,
      handler: async (req, res) => {
        if (req.method !== 'GET' || !isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        const cli = await doctorSnapshot(hooks.runtime())
        writeJson(res, 200, {
          ok: cli.ok,
          version: hooks.version,
          cli,
          settings: hooks.settings(),
          settingsPath: settingsPath(),
          tools: hooks.tools(),
        })
      },
    },
    {
      kind: 'exact',
      path: `${FEISHU_API_PREFIX}/settings`,
      handler: async (req, res) => {
        if (req.method !== 'POST' || !isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        let body
        try {
          body = await readJsonBody(req)
        } catch {
          writeJson(res, 400, { ok: false, error: '请求体无效' })
          return
        }
        try {
          const settings = hooks.reload(body && typeof body === 'object' ? body : {})
          writeJson(res, 200, { ok: true, settings, tools: hooks.tools(), settingsPath: settingsPath() })
        } catch (error) {
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    },
    {
      kind: 'exact',
      path: `${FEISHU_API_PREFIX}/client-state`,
      handler: async (req, res) => {
        if (req.method !== 'GET' || !isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        const clientModules = hooks.clientModules ? hooks.clientModules() : undefined
        if (!clientModules) {
          writeJson(res, 200, { ok: false, available: false })
          return
        }
        let graph
        try {
          graph = clientModules.graph()
        } catch (error) {
          writeJson(res, 200, { ok: false, available: true, error: String(error?.message ?? error) })
          return
        }
        const entries = Array.isArray(graph?.entries) ? graph.entries : []
        const mine = entries.filter((entry) => JSON.stringify(entry).includes('dsh-feishu'))
        const clientPath = typeof clientModules.clientPath === 'function' ? clientModules.clientPath('dsh-feishu') : undefined
        writeJson(res, 200, { ok: true, available: true, clientPath: clientPath ?? null, entries: mine })
      },
    },
    {
      kind: 'exact',
      path: `${FEISHU_API_PREFIX}/test`,
      handler: async (req, res) => {
        if (req.method !== 'POST' || !isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
          return
        }
        writeJson(res, 200, { ok: true, cli: await doctorSnapshot(hooks.runtime()) })
      },
    },
  ]

  const disposers = []
  for (const route of routes) disposers.push(ctx.webServer.register(route))
  return disposers
}

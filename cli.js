/**
 * lark-cli process layer for the dsh-feishu bundle.
 *
 * Every command is an argument array passed to `execFile` — never a shell
 * string. Authentication, token refresh and permission handling stay with
 * lark-cli, so the plugin stores no credentials.
 *
 * @module dsh-feishu/cli
 */

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'

const CLI_MAX_BUFFER = 8 * 1024 * 1024

/** Directories a GUI-launched Harness may not have on PATH. */
function defaultSearchDirs() {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    `${homedir()}/.npm-global/bin`,
    `${homedir()}/.local/bin`,
    `${homedir()}/bin`,
    '/usr/bin',
  ]
}

/**
 * Build the per-activation runtime facts from persisted settings.
 *
 * @param {Record<string, unknown>} settings - validated plugin settings.
 */
export function buildRuntime(settings) {
  const larkCliPath = typeof settings.larkCliPath === 'string' && settings.larkCliPath !== ''
    ? settings.larkCliPath
    : 'lark-cli'
  return {
    larkCliPath,
    /** Absolute paths are used verbatim; a bare name is resolved on first use. */
    resolvedCli: larkCliPath.includes('/') ? larkCliPath : '',
    timeoutMs: typeof settings.timeoutMs === 'number' ? settings.timeoutMs : 60_000,
    workdir: typeof settings.workdir === 'string' && settings.workdir !== '' ? settings.workdir : homedir(),
    identity: typeof settings.identity === 'string' ? settings.identity : 'auto',
  }
}

/**
 * Locate the CLI once, because a Harness started from the Dock may carry a
 * minimal PATH that lacks the Homebrew or npm global bin directory.
 *
 * @param {ReturnType<typeof buildRuntime>} runtime - runtime facts.
 * @returns {string} an executable path, or the original bare name.
 */
export function resolveCli(runtime) {
  if (runtime.resolvedCli) return runtime.resolvedCli
  const dirs = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    ...defaultSearchDirs(),
  ]
  for (const dir of dirs) {
    const candidate = `${dir}/${runtime.larkCliPath}`
    try {
      accessSync(candidate, constants.X_OK)
      runtime.resolvedCli = candidate
      return candidate
    } catch {
      // keep looking
    }
  }
  runtime.resolvedCli = runtime.larkCliPath
  return runtime.resolvedCli
}

/** Trim and cap a diagnostic string. */
export function clip(value, limit = 600) {
  const text = String(value ?? '').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Stringify an unknown scalar field for a string-typed output slot. */
export function str(value) {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

/** Strip the `<h>` highlight tags lark-cli adds to search titles. */
export function plainTitle(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Run lark-cli and capture its output. `exec.signal` cancels the child process.
 *
 * @param {ReturnType<typeof buildRuntime>} runtime - runtime facts.
 * @param {string[]} args - arguments passed without a shell.
 * @param {{ signal?: AbortSignal } | undefined} exec - tool run context.
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export function runCli(runtime, args, exec) {
  const bin = resolveCli(runtime)
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      cwd: runtime.workdir,
      env: { ...process.env },
      timeout: runtime.timeoutMs,
      maxBuffer: CLI_MAX_BUFFER,
      windowsHide: true,
      ...(exec?.signal ? { signal: exec.signal } : {}),
    }, (error, stdout, stderr) => {
      const out = String(stdout ?? '')
      const err = String(stderr ?? '')
      if (error?.code === 'ENOENT') {
        reject(new Error(
          `lark-cli was not found (command: ${runtime.larkCliPath}). Install it with \`npm i -g @larksuite/cli\`, ` +
          'then authenticate once with `lark-cli auth login`. If it lives somewhere unusual, set the CLI path on the ' +
          'plugin settings page (Settings → 飞书) or with `larkCliPath` in this plugin row\'s config.',
        ))
        return
      }
      if (error && out.trim() === '') {
        // lark-cli prints its JSON envelope on stderr for rejected calls; hand it
        // to the JSON reader so the model sees message + hint instead of a blob.
        if (err.trim().startsWith('{')) {
          resolve({ stdout: err, stderr: '' })
          return
        }
        reject(new Error(`lark-cli ${args.join(' ')} failed: ${clip(err) || clip(error.message)}`))
        return
      }
      resolve({ stdout: out, stderr: err })
    })
  })
}

/**
 * Run lark-cli and parse its JSON envelope, turning `ok: false` into a thrown
 * error carrying lark-cli's own message and hint.
 *
 * @param {ReturnType<typeof buildRuntime>} runtime - runtime facts.
 * @param {string[]} args - arguments without a shell.
 * @param {{ signal?: AbortSignal } | undefined} exec - tool run context.
 * @returns {Promise<any>} the parsed envelope.
 */
export async function runCliJson(runtime, args, exec) {
  const { stdout, stderr } = await runCli(runtime, args, exec)
  const text = stdout.trim()
  if (text === '') {
    throw new Error(`lark-cli ${args.join(' ')} printed no JSON${stderr ? `: ${clip(stderr)}` : ''}`)
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`lark-cli ${args.join(' ')} printed non-JSON output: ${clip(text)}`)
  }
  if (parsed && parsed.ok === false) {
    const detail = parsed.error ?? {}
    const message = typeof detail.message === 'string' ? detail.message : 'lark-cli rejected the call'
    throw new Error([message, typeof detail.hint === 'string' ? detail.hint : ''].filter(Boolean).join(' — '))
  }
  return parsed
}

/** Resolve the default `--as` for a tool call: explicit argument, then settings. */
export function identityArgs(runtime, requested, fallback = 'auto') {
  const identity = typeof requested === 'string' && requested !== ''
    ? requested
    : runtime.identity !== 'auto'
      ? runtime.identity
      : fallback
  return identity === 'auto' ? [] : ['--as', identity]
}

/** Require a non-empty string argument. */
export function requireString(value, name) {
  const text = str(value).trim()
  if (text === '') throw new Error(`\`${name}\` must be a non-empty string`)
  return text
}

/** First array found under one of `keys` in `value`. */
export function firstArray(value, keys) {
  if (!value || typeof value !== 'object') return []
  for (const key of keys) {
    if (Array.isArray(value[key])) return value[key]
  }
  return []
}

/**
 * Normalize a lark-cli time value (string, epoch number, or an object with
 * `date` / `datetime` / `timestamp`).
 *
 * @param {unknown} value - raw time field.
 * @returns {string} readable time or an empty string.
 */
export function normalizeTime(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value
    try {
      return new Date(ms).toISOString()
    } catch {
      return String(value)
    }
  }
  if (typeof value === 'object') {
    const record = /** @type {Record<string, unknown>} */ (value)
    for (const key of ['datetime', 'iso', 'time', 'date', 'timestamp']) {
      const candidate = record[key]
      if (candidate !== null && candidate !== undefined && candidate !== '') return normalizeTime(candidate)
    }
  }
  return ''
}

/** Compact JSON for a note field, capped. */
export function compactJson(value, limit = 800) {
  try {
    return clip(JSON.stringify(value), limit)
  } catch {
    return ''
  }
}

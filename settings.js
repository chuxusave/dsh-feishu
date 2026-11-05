/**
 * Persisted plugin settings for the dsh-feishu bundle.
 *
 * A small JSON file beside the profile keeps this bundle dependency-free while
 * still giving the settings page something durable and private (mode 0600).
 * Environment variables are read at call time so a profile restart picks up
 * whatever the Harness exported.
 *
 * @module dsh-feishu/settings
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const IDENTITIES = new Set(['auto', 'bot', 'user'])

/** Defaults used when no settings file exists or a field is invalid. */
export const DEFAULT_SETTINGS = Object.freeze({
  larkCliPath: 'lark-cli',
  identity: 'auto',
  timeoutMs: 60_000,
  workdir: '',
  readOnly: false,
  allowBaseWrite: true,
  allowCalendarWrite: true,
  allowSendMessage: true,
})

/** Directory that owns the settings file: the profile when there is one. */
function settingsDir() {
  const profileDir = process.env.DSH_PROFILE_DIR
  if (typeof profileDir === 'string' && profileDir !== '') return profileDir
  return join(homedir(), '.dsh')
}

/** Absolute path of the settings file. */
export function settingsPath() {
  return join(settingsDir(), 'dsh-feishu.settings.json')
}

/** Coerce one raw settings record into the validated shape. */
export function sanitizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const timeout = Number(input.timeoutMs)
  return {
    larkCliPath: typeof input.larkCliPath === 'string' && input.larkCliPath.trim() !== ''
      ? input.larkCliPath.trim()
      : DEFAULT_SETTINGS.larkCliPath,
    identity: typeof input.identity === 'string' && IDENTITIES.has(input.identity)
      ? input.identity
      : DEFAULT_SETTINGS.identity,
    timeoutMs: Number.isFinite(timeout) && timeout >= 5_000 && timeout <= 600_000
      ? Math.floor(timeout)
      : DEFAULT_SETTINGS.timeoutMs,
    workdir: typeof input.workdir === 'string' ? input.workdir.trim() : DEFAULT_SETTINGS.workdir,
    readOnly: input.readOnly === true,
    allowBaseWrite: input.allowBaseWrite !== false,
    allowCalendarWrite: input.allowCalendarWrite !== false,
    allowSendMessage: input.allowSendMessage !== false,
  }
}

/**
 * Read the persisted settings, falling back to defaults for a missing or
 * unreadable file.
 *
 * @returns {ReturnType<typeof sanitizeSettings>} validated settings.
 */
export function loadSettings() {
  try {
    const text = readFileSync(settingsPath(), 'utf8')
    return sanitizeSettings(JSON.parse(text))
  } catch {
    return sanitizeSettings({})
  }
}

/**
 * Merge a patch into the persisted settings and write them back.
 *
 * @param {Record<string, unknown>} patch - partial settings from the UI.
 * @returns {ReturnType<typeof sanitizeSettings>} the saved settings.
 */
export function saveSettings(patch) {
  const next = sanitizeSettings({ ...loadSettings(), ...(patch ?? {}) })
  const dir = settingsDir()
  mkdirSync(dir, { recursive: true })
  const file = settingsPath()
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    // best effort: some filesystems ignore the mode
  }
  return next
}

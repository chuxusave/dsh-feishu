/**
 * dsh-feishu — Feishu/Lark tools for DeepSeek Harness.
 *
 * The bundle registers Host tools that shell out to the official `lark-cli`
 * (npm: `@larksuite/cli`) with an argument array — never through a shell. All
 * authentication, token refresh and permission handling stay in lark-cli, so
 * this plugin stores no credentials.
 *
 * @module dsh-feishu
 */

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'

/** Bundle row name; must match `package.json` `name`. */
export const name = 'dsh-feishu'

/** The tool registry must exist before tools can be registered. */
export const inject = ['tools']

const CLI_MAX_BUFFER = 8 * 1024 * 1024
const MAX_DOC_CHARS = 200_000
const MAX_LIST_ITEMS = 100

/**
 * Resolve deployment options. The bundle declares no Config schema on purpose,
 * so it installs with zero required settings; every field below is optional and
 * is read from the row's `config` in the profile patch.
 *
 * @param {unknown} config - the row `config` object from the loader.
 */
function resolveConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const larkCliPath = typeof c.larkCliPath === 'string' && c.larkCliPath.trim() !== ''
    ? c.larkCliPath.trim()
    : 'lark-cli'
  return {
    larkCliPath,
    /** Absolute path is respected as given; a bare name is resolved on first use. */
    resolvedCli: larkCliPath.includes('/') ? larkCliPath : '',
    workdir: typeof c.workdir === 'string' && c.workdir.trim() !== '' ? c.workdir.trim() : homedir(),
    timeoutMs: Number.isFinite(c.timeoutMs) && c.timeoutMs > 0 ? Math.floor(c.timeoutMs) : 60_000,
    /** When true the write tool is not registered at all. */
    readOnly: c.readOnly === true,
    /** Extra directories searched for a bare `lark-cli` name. */
    searchDirs: Array.isArray(c.searchDirs) ? c.searchDirs.filter((d) => typeof d === 'string') : [],
  }
}

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
 * Locate the CLI once, because a Harness started from the Dock may carry a
 * minimal PATH that lacks the Homebrew or npm global bin directory.
 *
 * @param {ReturnType<typeof resolveConfig>} cfg - resolved options.
 * @returns {string} an executable path or the original bare name.
 */
function resolveCli(cfg) {
  if (cfg.resolvedCli) return cfg.resolvedCli
  const dirs = [
    ...(process.env.PATH ?? '').split(':').filter(Boolean),
    ...cfg.searchDirs,
    ...defaultSearchDirs(),
  ]
  for (const dir of dirs) {
    const candidate = `${dir}/${cfg.larkCliPath}`
    try {
      accessSync(candidate, constants.X_OK)
      cfg.resolvedCli = candidate
      return candidate
    } catch {
      // keep looking
    }
  }
  cfg.resolvedCli = cfg.larkCliPath
  return cfg.resolvedCli
}

/** Trim and cap a diagnostic string. */
function clip(value, limit = 600) {
  const text = String(value ?? '').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Run lark-cli and capture its output. `exec.signal` cancels the child process.
 *
 * @param {ReturnType<typeof resolveConfig>} cfg - resolved options.
 * @param {string[]} args - arguments passed without a shell.
 * @param {{ signal?: AbortSignal } | undefined} exec - tool run context.
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
function runCli(cfg, args, exec) {
  const bin = resolveCli(cfg)
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      cwd: cfg.workdir,
      env: { ...process.env },
      timeout: cfg.timeoutMs,
      maxBuffer: CLI_MAX_BUFFER,
      windowsHide: true,
      ...(exec?.signal ? { signal: exec.signal } : {}),
    }, (error, stdout, stderr) => {
      const out = String(stdout ?? '')
      const err = String(stderr ?? '')
      if (error?.code === 'ENOENT') {
        reject(new Error(
          `lark-cli was not found (command: ${cfg.larkCliPath}). Install it with \`npm i -g @larksuite/cli\`, ` +
          'then authenticate once with `lark-cli auth login`. If it is installed somewhere unusual, set ' +
          '`larkCliPath` (absolute path) in this plugin row\'s config.',
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
 * @param {ReturnType<typeof resolveConfig>} cfg - resolved options.
 * @param {string[]} args - arguments without a shell.
 * @param {{ signal?: AbortSignal } | undefined} exec - tool run context.
 * @returns {Promise<any>} the parsed envelope.
 */
async function runCliJson(cfg, args, exec) {
  const { stdout, stderr } = await runCli(cfg, args, exec)
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

/** Strip the `<h>` highlight tags lark-cli adds to search titles. */
function plainTitle(value) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/** Clamp a repeated-list result. */
function take(items) {
  const list = Array.isArray(items) ? items : []
  return { list: list.slice(0, MAX_LIST_ITEMS), truncated: list.length > MAX_LIST_ITEMS }
}

/** Stringify an unknown scalar field for a string-typed output slot. */
function str(value) {
  if (value === null || value === undefined) return ''
  return typeof value === 'string' ? value : String(value)
}

/** Build one tool definition and register it through a scoped effect. */
function register(ctx, definition) {
  ctx.effect(() => ctx.tools.register(definition))
}

/**
 * Register every Feishu tool on the tool registry.
 *
 * @param {any} ctx - the plugin context.
 * @param {ReturnType<typeof resolveConfig>} cfg - resolved options.
 */
function registerTools(ctx, cfg) {
  register(ctx, {
    name: 'feishu_status',
    description:
      'Check the local Feishu/Lark CLI setup: whether lark-cli is reachable and which identities (bot, user) are authenticated. ' +
      'Run this first when a Feishu tool fails with an authorization or not-found error.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'bot', 'user', 'summary'],
        properties: {
          ok: { type: 'boolean' },
          bot: { type: 'string' },
          user: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(_args, exec) {
      const raw = await runCli(cfg, ['doctor'], exec)
      const text = raw.stdout.trim()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(`could not read \`lark-cli doctor\` output: ${clip(text || raw.stderr)}`)
      }
      const checks = Array.isArray(parsed.checks) ? parsed.checks : []
      const state = (id) => {
        const check = checks.find((item) => item?.name === id)
        return check ? str(check.status) : 'unknown'
      }
      const bot = state('bot_identity')
      const user = state('user_identity')
      const open = state('endpoint_open')
      const ok = parsed.ok === true
      const summary = [
        ok ? 'Feishu CLI: ready.' : 'Feishu CLI: needs attention.',
        `bot=${bot}, user=${user}, api=${open}.`,
        ok ? '' : 'Run `lark-cli auth login` in a terminal (or fix the reported check) and retry.',
      ].filter(Boolean).join(' ')
      return { ok, bot, user, summary }
    },
  })

  register(ctx, {
    name: 'feishu_find_chats',
    description:
      'Find Feishu group chats (and, with the user identity, single chats) and return their chat_id. ' +
      'Pass `query` to search by name or member, or omit it to list chats the current identity has joined. ' +
      'Use the returned id with feishu_send_message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keyword matched against chat and member names. Omit to list joined chats.' },
        types: {
          type: 'string',
          enum: ['group', 'p2p'],
          description: 'Which chats to list when `query` is omitted: group (default) or p2p (user identity only).',
        },
        as: {
          type: 'string',
          enum: ['auto', 'bot', 'user'],
          description: 'Identity to call with. Defaults to lark-cli\'s own choice.',
        },
        limit: { type: 'number', description: 'Maximum chats to return (1-100, default 20).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'chats'],
        properties: {
          count: { type: 'integer' },
          chats: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'name', 'mode'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                mode: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0
          ? 'No Feishu chats matched.'
          : [`Found ${value.count} Feishu chat(s):`, ...value.chats.map((c) => `- ${c.name || '(no name)'} — ${c.id}${c.mode ? ` (${c.mode})` : ''}`)].join('\n'),
      }],
    },
    async execute(args, exec) {
      const limit = Number.isFinite(args.limit) ? Math.min(Math.max(Math.floor(args.limit), 1), MAX_LIST_ITEMS) : 20
      const common = ['--page-size', String(limit)]
      const identity = args.as && args.as !== 'auto' ? ['--as', args.as] : []
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const command = query
        ? ['im', '+chat-search', '--query', query, ...common, ...identity]
        : ['im', '+chat-list', '--types', args.types === 'p2p' ? 'p2p' : 'group', ...common, ...identity]
      const parsed = await runCliJson(cfg, command, exec)
      const data = parsed.data ?? {}
      const { list } = take(data.chats ?? data.items)
      const chats = list.map((chat) => ({
        id: str(chat?.chat_id ?? chat?.id),
        name: str(chat?.name),
        mode: str(chat?.chat_mode ?? chat?.mode),
      }))
      return { count: chats.length, chats }
    },
  })

  register(ctx, {
    name: 'feishu_search_docs',
    description:
      'Search the signed-in user\'s Feishu cloud docs, wiki pages, spreadsheets and bitables by keyword. ' +
      'Returns titles and URLs. Use feishu_read_doc to read a DOCX or wiki document body.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Search keyword.' },
        limit: { type: 'number', description: 'Maximum results to return (1-20, default 10).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['count', 'docs'],
        properties: {
          count: { type: 'integer' },
          docs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'url', 'type'],
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                type: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0
          ? 'No Feishu documents matched.'
          : [`Found ${value.count} Feishu document(s):`, ...value.docs.map((d) => `- ${d.title || '(untitled)'} [${d.type}] — ${d.url}`)].join('\n'),
      }],
    },
    async execute(args, exec) {
      const query = str(args.query).trim()
      if (query === '') throw new Error('`query` must be a non-empty string')
      const limit = Number.isFinite(args.limit) ? Math.min(Math.max(Math.floor(args.limit), 1), 20) : 10
      const parsed = await runCliJson(cfg, ['docs', '+search', '--query', query, '--page-size', String(limit)], exec)
      const results = Array.isArray(parsed.data?.results) ? parsed.data.results : []
      const docs = results.slice(0, limit).map((item) => ({
        title: plainTitle(item?.title_highlighted ?? item?.result_meta?.title),
        url: str(item?.result_meta?.url),
        type: str(item?.result_meta?.doc_types ?? item?.entity_type),
      }))
      return { count: docs.length, docs }
    },
  })

  register(ctx, {
    name: 'feishu_read_doc',
    description:
      'Read the body of a Feishu DOCX document or a wiki page that resolves to a DOCX, as Markdown. ' +
      'Pass a docx/wiki URL or token. Bitable (base) and spreadsheet contents are not readable through this tool.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['doc'],
      properties: {
        doc: { type: 'string', description: 'Feishu docx URL/token, or a wiki URL that resolves to a docx.' },
        format: {
          type: 'string',
          enum: ['markdown', 'im-markdown', 'xml'],
          description: 'Output format; markdown is easiest to post-process (default markdown).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['documentId', 'revisionId', 'content', 'truncated'],
        properties: {
          documentId: { type: 'string' },
          revisionId: { type: 'string' },
          content: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.content}${value.truncated ? `\n\n[content truncated at ${MAX_DOC_CHARS} characters]` : ''}`,
      }],
    },
    async execute(args, exec) {
      const doc = str(args.doc).trim()
      if (doc === '') throw new Error('`doc` must be a non-empty URL or token')
      const format = ['markdown', 'im-markdown', 'xml'].includes(args.format) ? args.format : 'markdown'
      const parsed = await runCliJson(cfg, ['docs', '+fetch', '--doc', doc, '--doc-format', format], exec)
      const document = parsed.data?.document ?? {}
      const full = str(document.content)
      const truncated = full.length > MAX_DOC_CHARS
      return {
        documentId: str(document.document_id ?? document.token),
        revisionId: str(document.revision_id),
        content: truncated ? full.slice(0, MAX_DOC_CHARS) : full,
        truncated,
      }
    },
  })

  if (cfg.readOnly) return

  register(ctx, {
    name: 'feishu_send_message',
    description:
      'Send a Feishu message to a chat (chat_id, oc_…) or a direct message (user open_id, ou_…). ' +
      'Pass `text` for plain text or `markdown` for rich text. Prefer `dryRun: true` on the first call to preview the ' +
      'request without sending. The bot identity must already be a member of the target chat.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Plain-text message body. Mutually exclusive with `markdown`.' },
        markdown: { type: 'string', description: 'Markdown/rich-text body sent as a post message. Mutually exclusive with `text`.' },
        chatId: { type: 'string', description: 'Target chat_id (oc_…). Mutually exclusive with `userId`.' },
        userId: { type: 'string', description: 'Target user open_id (ou_…) for a direct message. Mutually exclusive with `chatId`.' },
        as: {
          type: 'string',
          enum: ['bot', 'user', 'auto'],
          description: 'Sending identity; defaults to bot. user needs the im:message.send_as_user scope.',
        },
        dryRun: { type: 'boolean', description: 'Preview the request without sending it.' },
        idempotencyKey: { type: 'string', description: 'Optional key (max 50 chars) that prevents duplicate sends.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'messageId', 'target', 'summary'],
        properties: {
          ok: { type: 'boolean' },
          messageId: { type: 'string' },
          target: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const text = str(args.text).trim()
      const markdown = str(args.markdown).trim()
      const chatId = str(args.chatId).trim()
      const userId = str(args.userId).trim()
      if (text === '' && markdown === '') throw new Error('one of `text` or `markdown` is required')
      if (text !== '' && markdown !== '') throw new Error('`text` and `markdown` are mutually exclusive')
      if (chatId === '' && userId === '') throw new Error('one of `chatId` or `userId` is required')
      if (chatId !== '' && userId !== '') throw new Error('`chatId` and `userId` are mutually exclusive')

      const command = ['im', '+messages-send']
      if (chatId !== '') command.push('--chat-id', chatId)
      if (userId !== '') command.push('--user-id', userId)
      command.push(markdown !== '' ? '--markdown' : '--text', markdown !== '' ? markdown : text)
      // Sending as the bot is what works out of the box; user sends need an extra scope.
      const identity = args.as ?? 'bot'
      if (identity !== 'auto') command.push('--as', identity)
      if (args.idempotencyKey) command.push('--idempotency-key', str(args.idempotencyKey).slice(0, 50))
      if (args.dryRun === true) command.push('--dry-run')

      const parsed = await runCliJson(cfg, command, exec)
      const data = parsed.data ?? {}
      const messageId = str(data.message_id ?? data.message?.message_id ?? data.messages?.[0]?.message_id)
      const target = chatId !== '' ? chatId : userId
      const ok = parsed.ok !== false
      const summary = args.dryRun === true
        ? `Dry run: would send ${markdown !== '' ? 'markdown' : 'text'} to ${target} as ${parsed.identity ?? 'auto'}.`
        : `Sent ${markdown !== '' ? 'markdown' : 'text'} to ${target}${messageId ? ` (message ${messageId})` : ''}.`
      return { ok, messageId, target, summary }
    },
  })
}

/**
 * Bundle entry point.
 *
 * @param {any} ctx - the plugin context.
 * @param {unknown} config - the row `config` from the profile patch.
 */
export function apply(ctx, config) {
  registerTools(ctx, resolveConfig(config))
}

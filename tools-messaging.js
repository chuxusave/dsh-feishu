/**
 * Messaging and document tools: status, chat discovery, doc search/read, and
 * outbound messages.
 *
 * @module dsh-feishu/tools-messaging
 */

import { execFile } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'

import {
  clip,
  identityArgs,
  plainTitle,
  requireString,
  runCli,
  runCliJson,
  str,
} from './cli.js'

const MAX_LIST_ITEMS = 100
const MAX_DOC_CHARS = 200_000

/** Whether a media argument is already a lark key or a remote URL. */
function isRemoteRef(value) {
  return /^https?:\/\//i.test(value) || /^(img|file)_[A-Za-z0-9]+$/.test(value)
}

/**
 * Turn a media argument into the cwd-relative path lark-cli accepts. Keys and
 * URLs pass through; local paths must live inside the configured workdir
 * because lark-cli rejects absolute and parent-relative paths.
 *
 * @param {ReturnType<import('./cli.js').buildRuntime>} runtime - runtime facts.
 * @param {string} value - path, key or URL.
 * @param {string} label - field name for diagnostics.
 * @returns {string} the argument to hand to lark-cli.
 */
function mediaPath(runtime, value, label) {
  if (isRemoteRef(value)) return value
  const absolute = isAbsolute(value) ? value : join(runtime.workdir, value)
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`)
  const rel = relative(runtime.workdir, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `${label} must live inside the working directory ${runtime.workdir} (lark-cli rejects absolute and parent paths). ` +
      'Move the file there, or change `workdir` in the plugin settings.',
    )
  }
  return rel
}

/**
 * Extract a first-frame JPEG cover for a local video, because
 * `im +messages-send --video` requires `--video-cover`.
 *
 * @param {ReturnType<import('./cli.js').buildRuntime>} runtime - runtime facts.
 * @param {string} videoRel - workdir-relative video path.
 * @returns {Promise<{ rel: string, cleanup: () => void }>}
 */
function makeVideoCover(runtime, videoRel) {
  const name = `.dsh-feishu-cover-${Date.now()}.jpg`
  const absolute = join(runtime.workdir, name)
  const cleanup = () => {
    try {
      unlinkSync(absolute)
    } catch {
      // best effort
    }
  }
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-ss', '1', '-i', videoRel, '-frames:v', '1', '-vf', 'scale=640:-2', '-y', name], {
      cwd: runtime.workdir,
      timeout: 20_000,
    }, (error) => {
      if (error || !existsSync(absolute)) {
        cleanup()
        reject(new Error(
          'could not generate a video cover with ffmpeg (install ffmpeg, or pass `videoCover` explicitly).',
        ))
        return
      }
      resolve({ rel: name, cleanup })
    })
  })
}

/** Clamp a repeated-list result. */
function take(items) {
  const list = Array.isArray(items) ? items : []
  return { list: list.slice(0, MAX_LIST_ITEMS), truncated: list.length > MAX_LIST_ITEMS }
}

/**
 * Build the messaging tools for one settings snapshot.
 *
 * @param {ReturnType<import('./cli.js').buildRuntime>} runtime - runtime facts.
 * @param {ReturnType<import('./settings.js').sanitizeSettings>} settings - validated settings.
 * @returns {Array<Record<string, unknown>>} tool definitions.
 */
export function buildMessagingTools(runtime, settings) {
  const tools = [
    {
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
        const raw = await runCli(runtime, ['doctor'], exec)
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
        const api = state('endpoint_open')
        const ok = parsed.ok === true
        const summary = [
          ok ? 'Feishu CLI: ready.' : 'Feishu CLI: needs attention.',
          `bot=${bot}, user=${user}, api=${api}.`,
          `settings: identity=${settings.identity}, readOnly=${settings.readOnly ? 'on' : 'off'}.`,
          ok ? '' : 'Run `lark-cli auth login` in a terminal (or fix the reported check) and retry.',
        ].filter(Boolean).join(' ')
        return { ok, bot, user, summary }
      },
    },
    {
      name: 'feishu_find_chats',
      description:
        'Find Feishu group chats (and, with the user identity, single chats) and return their chat_id. ' +
        'Pass `query` to search by name or member, or omit it to list chats the current identity has joined. ' +
        'Use the returned id with feishu_send_message; chats marked external live in another tenant and cannot be messaged by a self-built app.',
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
            description: 'Identity to call with. Defaults to the plugin setting.',
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
                required: ['id', 'name', 'mode', 'external'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  mode: { type: 'string' },
                  external: { type: 'boolean' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? 'No Feishu chats matched.'
            : [`Found ${value.count} Feishu chat(s):`, ...value.chats.map((c) => `- ${c.name || '(no name)'} — ${c.id}${c.mode ? ` (${c.mode})` : ''}${c.external ? ' [外部群：自建应用无法发消息]' : ''}`)].join('\n'),
        }],
      },
      async execute(args, exec) {
        const limit = Number.isFinite(args.limit) ? Math.min(Math.max(Math.floor(args.limit), 1), MAX_LIST_ITEMS) : 20
        const common = ['--page-size', String(limit)]
        const identity = identityArgs(runtime, args.as)
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const command = query
          ? ['im', '+chat-search', '--query', query, ...common, ...identity]
          : ['im', '+chat-list', '--types', args.types === 'p2p' ? 'p2p' : 'group', ...common, ...identity]
        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const { list } = take(data.chats ?? data.items)
        const chats = list.map((chat) => ({
          id: str(chat?.chat_id ?? chat?.id),
          name: str(chat?.name),
          mode: str(chat?.chat_mode ?? chat?.mode),
          external: chat?.external === true,
        }))
        return { count: chats.length, chats }
      },
    },
    {
      name: 'feishu_search_docs',
      description:
        'Search the signed-in user\'s Feishu cloud docs, wiki pages, spreadsheets and bitables by keyword. ' +
        'Returns titles and URLs. Use feishu_read_doc to read a DOCX or wiki document body; ' +
        'feishu_base_tables / feishu_base_list_records work on a bitable (Base) URL.',
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
        const query = requireString(args.query, 'query')
        const limit = Number.isFinite(args.limit) ? Math.min(Math.max(Math.floor(args.limit), 1), 20) : 10
        const parsed = await runCliJson(runtime, ['docs', '+search', '--query', query, '--page-size', String(limit)], exec)
        const results = Array.isArray(parsed.data?.results) ? parsed.data.results : []
        const docs = results.slice(0, limit).map((item) => ({
          title: plainTitle(item?.title_highlighted ?? item?.result_meta?.title),
          url: str(item?.result_meta?.url),
          type: str(item?.result_meta?.doc_types ?? item?.entity_type),
        }))
        return { count: docs.length, docs }
      },
    },
    {
      name: 'feishu_read_doc',
      description:
        'Read the body of a Feishu DOCX document or a wiki page that resolves to a DOCX, as Markdown. ' +
        'Pass a docx/wiki URL or token. Bitable (base) and spreadsheet contents are read with the ' +
        'feishu_base_* tools instead.',
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
        const doc = requireString(args.doc, 'doc')
        const format = ['markdown', 'im-markdown', 'xml'].includes(args.format) ? args.format : 'markdown'
        const parsed = await runCliJson(runtime, ['docs', '+fetch', '--doc', doc, '--doc-format', format], exec)
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
    },
  ]

  if (settings.readOnly || !settings.allowSendMessage) return tools

  tools.push({
    name: 'feishu_send_message',
    description:
      'Send a Feishu message to a chat (chat_id, oc_…) or a direct message (user open_id, ou_…). ' +
      'Pass exactly one of `text`, `markdown`, `image`, `file` or `video`. Media accepts a lark key/URL, or a local path ' +
      'inside the configured working directory; a local video without `videoCover` gets a first-frame cover generated with ffmpeg. ' +
      'Prefer `dryRun: true` on the first call. The bot identity must already be a member of the target chat, and external-tenant ' +
      'chats cannot be messaged by a self-built app.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: 'Plain-text body. Send exactly one content kind.' },
        markdown: { type: 'string', description: 'Markdown/rich-text body sent as a post message.' },
        image: { type: 'string', description: 'Image key (img_…), URL, or local path inside the working directory.' },
        file: { type: 'string', description: 'File key (file_…), URL, or local path inside the working directory.' },
        video: { type: 'string', description: 'Video key (file_…), URL, or local path inside the working directory.' },
        videoCover: { type: 'string', description: 'Cover image for the video (key/URL/local path). Generated with ffmpeg when omitted.' },
        chatId: { type: 'string', description: 'Target chat_id (oc_…). Mutually exclusive with `userId`.' },
        userId: { type: 'string', description: 'Target user open_id (ou_…) for a direct message. Mutually exclusive with `chatId`.' },
        as: {
          type: 'string',
          enum: ['bot', 'user', 'auto'],
          description: 'Sending identity; defaults to the plugin setting, or bot.',
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
      const image = str(args.image).trim()
      const file = str(args.file).trim()
      const video = str(args.video).trim()
      const chatId = str(args.chatId).trim()
      const userId = str(args.userId).trim()
      if (chatId === '' && userId === '') throw new Error('one of `chatId` or `userId` is required')
      if (chatId !== '' && userId !== '') throw new Error('`chatId` and `userId` are mutually exclusive')

      const kinds = [text, markdown, image, file, video].filter((value) => value !== '')
      if (kinds.length === 0) throw new Error('pass one of `text`, `markdown`, `image`, `file` or `video`')
      if (kinds.length > 1) throw new Error('pass exactly one content kind: `text`, `markdown`, `image`, `file` or `video`')

      const command = ['im', '+messages-send']
      if (chatId !== '') command.push('--chat-id', chatId)
      if (userId !== '') command.push('--user-id', userId)

      let kind = 'text'
      let cleanup = () => {}
      if (text !== '') {
        kind = 'text'
        command.push('--text', text)
      } else if (markdown !== '') {
        kind = 'markdown'
        command.push('--markdown', markdown)
      } else if (image !== '') {
        kind = 'image'
        command.push('--image', mediaPath(runtime, image, 'image'))
      } else if (file !== '') {
        kind = 'file'
        command.push('--file', mediaPath(runtime, file, 'file'))
      } else {
        kind = 'video'
        const videoArg = mediaPath(runtime, video, 'video')
        let coverArg = ''
        if (typeof args.videoCover === 'string' && args.videoCover.trim() !== '') {
          coverArg = mediaPath(runtime, args.videoCover.trim(), 'videoCover')
        } else if (!isRemoteRef(videoArg)) {
          const cover = await makeVideoCover(runtime, videoArg)
          coverArg = cover.rel
          cleanup = cover.cleanup
        } else {
          throw new Error('a video given as a remote URL or file key needs an explicit `videoCover`')
        }
        command.push('--video', videoArg, '--video-cover', coverArg)
      }

      // Sending as the bot is what works out of the box; user sends need an extra scope.
      command.push(...identityArgs(runtime, args.as, 'bot'))
      if (args.idempotencyKey) command.push('--idempotency-key', str(args.idempotencyKey).slice(0, 50))
      if (args.dryRun === true) command.push('--dry-run')

      try {
        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const messageId = str(data.message_id ?? data.message?.message_id ?? data.messages?.[0]?.message_id)
        const target = chatId !== '' ? chatId : userId
        const ok = parsed.ok !== false
        const summary = args.dryRun === true
          ? `Dry run: would send ${kind} to ${target} as ${parsed.identity ?? 'auto'}.`
          : `Sent ${kind} to ${target}${messageId ? ` (message ${messageId})` : ''}.`
        return { ok, messageId, target, summary }
      } finally {
        cleanup()
      }
    },
  })

  return tools
}

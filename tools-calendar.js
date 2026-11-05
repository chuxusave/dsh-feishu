/**
 * Feishu calendar tools: agenda, free/busy and event creation.
 *
 * Calendar scopes are not granted by default: lark-cli reports the missing
 * scopes and the exact `lark-cli auth login --scope …` command in the tool
 * error, which the model relays to the user.
 *
 * @module dsh-feishu/tools-calendar
 */

import {
  compactJson,
  firstArray,
  identityArgs,
  normalizeTime,
  requireString,
  runCliJson,
  str,
} from './cli.js'

const EVENT_KEYS = ['items', 'events', 'agenda', 'event_list', 'timeline', 'timeblocks']

/** Normalize one agenda entry from lark-cli's varied envelope shapes. */
function normalizeEvent(item) {
  const raw = item && typeof item === 'object' ? item : {}
  const event = raw.event && typeof raw.event === 'object' ? raw.event : raw
  return {
    summary: str(event.summary ?? event.title ?? event.subject ?? event.name),
    start: normalizeTime(event.start_time ?? event.start ?? event.startTime ?? event.start_timestamp ?? raw.start_time),
    end: normalizeTime(event.end_time ?? event.end ?? event.endTime ?? event.end_timestamp ?? raw.end_time),
    eventId: str(event.event_id ?? event.eventId ?? event.id ?? event.uid),
  }
}

/** Normalize one busy/free interval. */
function normalizeInterval(item) {
  const raw = item && typeof item === 'object' ? item : {}
  const user = str(raw.user_id ?? raw.open_id ?? raw.user?.open_id)
  return {
    start: normalizeTime(raw.start_time ?? raw.start ?? raw.startTime ?? raw.start_timestamp),
    end: normalizeTime(raw.end_time ?? raw.end ?? raw.endTime ?? raw.end_timestamp),
    user,
  }
}

/**
 * Build the calendar tools for one settings snapshot.
 *
 * @param {ReturnType<import('./cli.js').buildRuntime>} runtime - runtime facts.
 * @param {ReturnType<import('./settings.js').sanitizeSettings>} settings - validated settings.
 * @returns {Array<Record<string, unknown>>} tool definitions.
 */
export function buildCalendarTools(runtime, settings) {
  const commonTimeFlags = (args) => {
    const flags = []
    if (typeof args.start === 'string' && args.start.trim() !== '') flags.push('--start', args.start.trim())
    if (typeof args.end === 'string' && args.end.trim() !== '') flags.push('--end', args.end.trim())
    if (typeof args.calendarId === 'string' && args.calendarId.trim() !== '') flags.push('--calendar-id', args.calendarId.trim())
    return flags
  }

  const tools = [
    {
      name: 'feishu_calendar_agenda',
      description:
        'View the Feishu calendar agenda (defaults to today). Pass ISO 8601 `start`/`end` (or YYYY-MM-DD) to widen the ' +
        'range; ranges over 40 days are split by lark-cli. Requires the calendar:calendar.event:read scope.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start: { type: 'string', description: 'Range start: ISO 8601 or YYYY-MM-DD (default: today).' },
          end: { type: 'string', description: 'Range end: ISO 8601 or YYYY-MM-DD (default: end of the start day).' },
          calendarId: { type: 'string', description: 'Calendar id (default: primary).' },
          as: {
            type: 'string',
            enum: ['auto', 'bot', 'user'],
            description: 'Identity to call with. Defaults to the plugin setting.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'events', 'note'],
          properties: {
            count: { type: 'integer' },
            events: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['summary', 'start', 'end', 'eventId'],
                properties: {
                  summary: { type: 'string' },
                  start: { type: 'string' },
                  end: { type: 'string' },
                  eventId: { type: 'string' },
                },
              },
            },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? (value.note || '日程清空（no events in this range）。')
            : [
              `Agenda (${value.count}):`,
              ...value.events.map((e) => `- ${e.start || '?'} → ${e.end || '?'}  ${e.summary || '(no title)'}${e.eventId ? `  [${e.eventId}]` : ''}`),
              value.note ? `note: ${value.note}` : '',
            ].filter(Boolean).join('\n'),
        }],
      },
      async execute(args, exec) {
        const command = ['calendar', '+agenda', '--json', ...commonTimeFlags(args), ...identityArgs(runtime, args.as)]
        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const items = firstArray(data, EVENT_KEYS)
        const events = items.map(normalizeEvent)
        const note = events.length === 0 && Object.keys(data).length > 0
          ? `raw: ${compactJson(data)}`
          : ''
        return { count: events.length, events, note }
      },
    },
    {
      name: 'feishu_calendar_freebusy',
      description:
        'Query Feishu free/busy windows. `type` = busy (default, merged busy intervals), free (free windows), ' +
        'common_free (intersection for several users) or raw_busy (raw event blocks with RSVP). ' +
        'For multi-user scheduling use common_free with `minDuration`. Requires calendar read scopes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start: { type: 'string', description: 'Range start: ISO 8601 or YYYY-MM-DD (default: today).' },
          end: { type: 'string', description: 'Range end: ISO 8601 or YYYY-MM-DD.' },
          userIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'User open_ids (ou_…). Default: the current user; bot identity requires at least one.',
          },
          type: {
            type: 'string',
            enum: ['busy', 'free', 'common_free', 'raw_busy'],
            description: 'View to return (default busy).',
          },
          minDuration: { type: 'string', description: 'Minimum window length for free/common_free, e.g. 30m or 1h.' },
          as: {
            type: 'string',
            enum: ['auto', 'bot', 'user'],
            description: 'Identity to call with. Defaults to the plugin setting.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'intervals', 'note'],
          properties: {
            count: { type: 'integer' },
            intervals: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['start', 'end', 'user'],
                properties: {
                  start: { type: 'string' },
                  end: { type: 'string' },
                  user: { type: 'string' },
                },
              },
            },
            note: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? (value.note || 'No intervals in this range.')
            : [
              `${value.count} interval(s):`,
              ...value.intervals.map((i) => `- ${i.start || '?'} → ${i.end || '?'}${i.user ? `  (${i.user})` : ''}`),
              value.note ? `note: ${value.note}` : '',
            ].filter(Boolean).join('\n'),
        }],
      },
      async execute(args, exec) {
        const command = ['calendar', '+freebusy', '--json', ...commonTimeFlags(args)]
        if (typeof args.type === 'string' && args.type !== '') command.push('--type', args.type)
        if (typeof args.minDuration === 'string' && args.minDuration.trim() !== '') command.push('--min-duration', args.minDuration.trim())
        if (Array.isArray(args.userIds)) {
          const ids = args.userIds.filter((id) => typeof id === 'string' && id.trim() !== '')
          if (ids.length > 0) command.push('--user-id', ids.join(','))
        }
        command.push(...identityArgs(runtime, args.as))

        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const rows = firstArray(data, ['items', 'intervals', 'busy', 'free', 'common_free', 'timeblocks'])
        const intervals = rows.map(normalizeInterval)
        const note = intervals.length === 0 && Object.keys(data).length > 0 ? `raw: ${compactJson(data)}` : ''
        return { count: intervals.length, intervals, note }
      },
    },
  ]

  if (settings.readOnly || !settings.allowCalendarWrite) return tools

  tools.push({
    name: 'feishu_calendar_create',
    description:
      'Create a Feishu calendar event and optionally invite attendees. Times are ISO 8601, e.g. ' +
      '2026-11-06T10:00:00+08:00. Invite people with `attendees` (open_ids, chat ids or room ids). ' +
      'Requires calendar write scopes; use `dryRun` to preview.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'start', 'end'],
      properties: {
        summary: { type: 'string', description: 'Event title.' },
        start: { type: 'string', description: 'Start time, ISO 8601.' },
        end: { type: 'string', description: 'End time, ISO 8601.' },
        description: { type: 'string', description: 'Event description as Markdown.' },
        attendees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attendee ids: user ou_…, chat oc_… or room omm_….',
        },
        calendarId: { type: 'string', description: 'Calendar id (default: primary).' },
        dryRun: { type: 'boolean', description: 'Preview the request without creating anything.' },
        as: {
          type: 'string',
          enum: ['auto', 'bot', 'user'],
          description: 'Identity to call with. Defaults to the plugin setting.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'eventId', 'summary'],
        properties: {
          ok: { type: 'boolean' },
          eventId: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      const topic = requireString(args.summary, 'summary')
      const start = requireString(args.start, 'start')
      const end = requireString(args.end, 'end')
      const command = ['calendar', '+create', '--summary', topic, '--start', start, '--end', end]
      if (typeof args.description === 'string' && args.description.trim() !== '') {
        command.push('--description', args.description)
      }
      if (Array.isArray(args.attendees)) {
        const ids = args.attendees.filter((id) => typeof id === 'string' && id.trim() !== '')
        if (ids.length > 0) command.push('--attendee-ids', ids.join(','))
      }
      if (typeof args.calendarId === 'string' && args.calendarId.trim() !== '') command.push('--calendar-id', args.calendarId.trim())
      if (args.dryRun === true) command.push('--dry-run')
      command.push(...identityArgs(runtime, args.as))

      const parsed = await runCliJson(runtime, command, exec)
      const data = parsed.data ?? {}
      const eventId = str(data.event?.event_id ?? data.event_id ?? data.event?.id ?? data.event?.uid)
      const summary = args.dryRun === true
        ? `Dry run: would create "${topic}" ${start} → ${end}.`
        : `Created "${topic}" ${start} → ${end}${eventId ? ` (event ${eventId})` : ''}.`
      return { ok: parsed.ok !== false, eventId, summary }
    },
  })

  return tools
}

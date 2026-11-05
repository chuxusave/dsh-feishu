/**
 * Feishu Base (多维表格) tools: tables, fields, record reads and record writes.
 *
 * @module dsh-feishu/tools-base
 */

import { clip, identityArgs, requireString, runCliJson, str } from './cli.js'

const MAX_RECORDS = 200

/**
 * Build the Base tools for one settings snapshot.
 *
 * @param {ReturnType<import('./cli.js').buildRuntime>} runtime - runtime facts.
 * @param {ReturnType<import('./settings.js').sanitizeSettings>} settings - validated settings.
 * @returns {Array<Record<string, unknown>>} tool definitions.
 */
export function buildBaseTools(runtime, settings) {
  /** Shared flags for every Base call. */
  const baseArgs = (args) => [
    '--base-token', requireString(args.baseToken, 'baseToken'),
    '--table-id', requireString(args.tableId, 'tableId'),
  ]

  const tools = [
    {
      name: 'feishu_base_tables',
      description:
        'List the tables of a Feishu Base (多维表格). Pass the base token from a base URL ' +
        '(https://xxx.feishu.cn/base/<token>) or the token itself. Use feishu_base_fields to see one table\'s columns.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['baseToken'],
        properties: {
          baseToken: { type: 'string', description: 'Base token: the `/base/<token>` part of the URL.' },
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
          required: ['count', 'tables'],
          properties: {
            count: { type: 'integer' },
            tables: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name', 'records'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  records: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? 'This Base has no tables.'
            : [`Base tables (${value.count}):`, ...value.tables.map((t) => `- ${t.name || '(unnamed)'} — ${t.id} (${t.records} records)`)].join('\n'),
        }],
      },
      async execute(args, exec) {
        const baseToken = requireString(args.baseToken, 'baseToken')
        const parsed = await runCliJson(runtime, ['base', '+table-list', '--base-token', baseToken, '--json', ...identityArgs(runtime, args.as)], exec)
        const tables = Array.isArray(parsed.data?.tables) ? parsed.data.tables : []
        return {
          count: tables.length,
          tables: tables.map((table) => ({
            id: str(table?.id),
            name: str(table?.name),
            records: Number.isFinite(table?.records_count) ? Math.floor(table.records_count) : 0,
          })),
        }
      },
    },
    {
      name: 'feishu_base_fields',
      description:
        'List the fields (columns) of one Feishu Base table: id, name and type. ' +
        'Read this before writing records so field names and value shapes are correct.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['baseToken', 'tableId'],
        properties: {
          baseToken: { type: 'string', description: 'Base token from the base URL.' },
          tableId: { type: 'string', description: 'Table id (tbl…) or table name.' },
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
          required: ['count', 'fields'],
          properties: {
            count: { type: 'integer' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name', 'type'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  type: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? 'This table has no fields.'
            : [`Table fields (${value.count}):`, ...value.fields.map((f) => `- ${f.name} [${f.type}] — ${f.id}`)].join('\n'),
        }],
      },
      async execute(args, exec) {
        const parsed = await runCliJson(runtime, ['base', '+field-list', ...baseArgs(args), '--json', ...identityArgs(runtime, args.as)], exec)
        const fields = Array.isArray(parsed.data?.fields) ? parsed.data.fields : []
        return {
          count: fields.length,
          fields: fields.map((field) => ({
            id: str(field?.id),
            name: str(field?.name),
            type: str(field?.type),
          })),
        }
      },
    },
    {
      name: 'feishu_base_list_records',
      description:
        'List or filter records of a Feishu Base table as objects keyed by field name. ' +
        'Filter with a JSON string such as {"logic":"and","conditions":[["Status","==","Done"]]}; ' +
        'sort with a JSON string such as [{"field":"Updated","desc":true}]. ' +
        'Returns at most `limit` records for one page; check `hasMore` and pass `offset`.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['baseToken', 'tableId'],
        properties: {
          baseToken: { type: 'string', description: 'Base token from the base URL.' },
          tableId: { type: 'string', description: 'Table id (tbl…) or table name.' },
          limit: { type: 'number', description: 'Records per page (1-200, default 20).' },
          offset: { type: 'number', description: 'Pagination offset (default 0).' },
          filter: { type: 'string', description: 'Filter JSON string, e.g. {"logic":"and","conditions":[["Status","==","Done"]]}.' },
          sort: { type: 'string', description: 'Sort JSON string, e.g. [{"field":"Updated","desc":true}].' },
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only project these field names (keeps output small).',
          },
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
          required: ['count', 'hasMore', 'fields', 'records'],
          properties: {
            count: { type: 'integer' },
            hasMore: { type: 'boolean' },
            fields: { type: 'array', items: { type: 'string' } },
            records: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: (_args, value) => {
          if (value.count === 0) return [{ type: 'text', text: 'No records matched.' }]
          const json = clip(JSON.stringify(value.records), 20_000)
          return [{
            type: 'text',
            text: [
              `Read ${value.count} record(s)${value.hasMore ? ' — more available, pass a larger offset' : ''}. Fields: ${value.fields.join(', ')}.`,
              json,
            ].join('\n'),
          }]
        },
      },
      async execute(args, exec) {
        const limit = Number.isFinite(args.limit) ? Math.min(Math.max(Math.floor(args.limit), 1), MAX_RECORDS) : 20
        const command = ['base', '+record-list', ...baseArgs(args), '--json', '--limit', String(limit)]
        const offset = Number.isFinite(args.offset) ? Math.max(Math.floor(args.offset), 0) : 0
        if (offset > 0) command.push('--offset', String(offset))
        if (typeof args.filter === 'string' && args.filter.trim() !== '') {
          // Fail fast on malformed JSON so the model gets a clear message.
          JSON.parse(args.filter)
          command.push('--filter-json', args.filter)
        }
        if (typeof args.sort === 'string' && args.sort.trim() !== '') {
          JSON.parse(args.sort)
          command.push('--sort-json', args.sort)
        }
        if (Array.isArray(args.fields)) {
          for (const field of args.fields) {
            if (typeof field === 'string' && field.trim() !== '') command.push('--field-id', field.trim())
          }
        }
        command.push(...identityArgs(runtime, args.as))

        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const names = Array.isArray(data.fields) ? data.fields.map((name) => str(name)) : []
        const rows = Array.isArray(data.data) ? data.data : []
        const ids = Array.isArray(data.record_id_list) ? data.record_id_list : []
        const records = rows.map((row, index) => {
          /** @type {Record<string, unknown>} */
          const record = { id: str(ids[index]) }
          if (Array.isArray(row)) {
            names.forEach((name, column) => {
              record[name] = row[column] ?? null
            })
          } else if (row && typeof row === 'object') {
            Object.assign(record, row)
          }
          return record
        })
        return {
          count: records.length,
          hasMore: data.has_more === true,
          fields: records.length > 0 ? Object.keys(records[0]).filter((key) => key !== 'id') : names,
          records,
        }
      },
    },
  ]

  if (settings.readOnly || !settings.allowBaseWrite) return tools

  tools.push({
    name: 'feishu_base_upsert_record',
    description:
      'Create or update one Feishu Base record. Without `recordId` it creates a record; with `recordId` it updates that ' +
      'record. `fields` is a top-level field-name → value map, e.g. {"Name":"Alice","Status":["Todo"]}. ' +
      'Call feishu_base_fields first to confirm writable fields and value shapes.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['baseToken', 'tableId', 'fields'],
      properties: {
        baseToken: { type: 'string', description: 'Base token from the base URL.' },
        tableId: { type: 'string', description: 'Table id (tbl…) or table name.' },
        fields: {
          type: 'object',
          additionalProperties: true,
          description: 'Field name → CellValue map. Do not wrap in a `fields` object.',
        },
        recordId: { type: 'string', description: 'Existing record id (rec…). Omit to create a new record.' },
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
        required: ['ok', 'recordId', 'summary'],
        properties: {
          ok: { type: 'boolean' },
          recordId: { type: 'string' },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
    },
    async execute(args, exec) {
      if (!args.fields || typeof args.fields !== 'object' || Object.keys(args.fields).length === 0) {
        throw new Error('`fields` must be a non-empty field name → value object')
      }
      const command = ['base', '+record-upsert', ...baseArgs(args), '--json', JSON.stringify(args.fields)]
      const recordId = str(args.recordId).trim()
      if (recordId !== '') command.push('--record-id', recordId)
      command.push(...identityArgs(runtime, args.as))

      const parsed = await runCliJson(runtime, command, exec)
      const data = parsed.data ?? {}
      const savedId = str(data.record_id ?? data.record?.record_id ?? data.records?.[0]?.record_id ?? recordId)
      const action = recordId !== '' ? 'Updated' : 'Created'
      return {
        ok: parsed.ok !== false,
        recordId: savedId,
        summary: `${action} record${savedId ? ` ${savedId}` : ''} in table ${requireString(args.tableId, 'tableId')}.`,
      }
    },
  })

  return tools
}

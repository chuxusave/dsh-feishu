/**
 * Feishu Sheets tools: workbook inspection, range reads and writes.
 *
 * @module dsh-feishu/tools-sheets
 */

import { clip, identityArgs, requireString, runCliJson, str } from './cli.js'

const MAX_CSV_CHARS = 50_000

/** Resolve the locator flags a Sheets call needs (token XOR url). */
function locatorArgs(args) {
  const url = str(args.url).trim()
  const token = str(args.spreadsheetToken).trim()
  if (url !== '' && token !== '') throw new Error('pass either `spreadsheetToken` or `url`, not both')
  if (url !== '') return ['--url', url]
  if (token !== '') return ['--spreadsheet-token', token]
  throw new Error('one of `spreadsheetToken` or `url` is required')
}

/** Resolve the sheet selector flags (id XOR name). */
function sheetArgs(args) {
  const id = str(args.sheetId).trim()
  const name = str(args.sheetName).trim()
  if (id !== '' && name !== '') throw new Error('pass either `sheetId` or `sheetName`, not both')
  if (id !== '') return ['--sheet-id', id]
  if (name !== '') return ['--sheet-name', name]
  throw new Error('one of `sheetId` or `sheetName` is required')
}

/**
 * Build the Sheets tools for one settings snapshot.
 *
 * @param {ReturnType<import('./cli.js').buildRuntime>} runtime - runtime facts.
 * @param {ReturnType<import('./settings.js').sanitizeSettings>} settings - validated settings.
 * @returns {Array<Record<string, unknown>>} tool definitions.
 */
export function buildSheetsTools(runtime, settings) {
  const tools = [
    {
      name: 'feishu_sheets_info',
      description:
        'List the sub-sheets (tabs) of a Feishu spreadsheet with their sheet_id, title, row/column counts and hidden state. ' +
        'Start here for any sheet task: later calls need the sheet_id or sheet title. ' +
        'Pass a spreadsheet token (the /sheets/<token> part of the URL) or the full URL.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          spreadsheetToken: { type: 'string', description: 'Spreadsheet token from a /sheets/<token> URL.' },
          url: { type: 'string', description: 'Spreadsheet URL. Mutually exclusive with `spreadsheetToken`.' },
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
          required: ['title', 'count', 'sheets'],
          properties: {
            title: { type: 'string' },
            count: { type: 'integer' },
            sheets: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name', 'rows', 'columns', 'hidden'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  rows: { type: 'integer' },
                  columns: { type: 'integer' },
                  hidden: { type: 'boolean' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? 'This spreadsheet has no sub-sheets.'
            : [`Spreadsheet "${value.title}" — ${value.count} sheet(s):`,
              ...value.sheets.map((sheet) => `- ${sheet.name} — id ${sheet.id} (${sheet.rows}×${sheet.columns})${sheet.hidden ? ' [hidden]' : ''}`)].join('\n'),
        }],
      },
      async execute(args, exec) {
        const command = ['sheets', '+workbook-info', ...locatorArgs(args), '--json', ...identityArgs(runtime, args.as)]
        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const sheets = Array.isArray(data.sheets) ? data.sheets : []
        return {
          title: str(data.title),
          count: sheets.length,
          sheets: sheets.map((sheet) => ({
            id: str(sheet?.sheet_id),
            name: str(sheet?.sheet_name),
            rows: Number.isFinite(sheet?.row_count) ? Math.floor(sheet.row_count) : 0,
            columns: Number.isFinite(sheet?.column_count) ? Math.floor(sheet.column_count) : 0,
            hidden: sheet?.is_hidden === true,
          })),
        }
      },
    },
    {
      name: 'feishu_sheets_read',
      description:
        'Read a range of a Feishu spreadsheet as CSV text (with an A1 actual range). ' +
        'Call feishu_sheets_info first for the sheet_id/title. Default range is A1:Z100; narrow it for big sheets.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sheetId'],
        properties: {
          spreadsheetToken: { type: 'string', description: 'Spreadsheet token from a /sheets/<token> URL.' },
          url: { type: 'string', description: 'Spreadsheet URL. Mutually exclusive with `spreadsheetToken`.' },
          sheetId: { type: 'string', description: 'Sheet id from feishu_sheets_info.' },
          sheetName: { type: 'string', description: 'Sheet title, as an alternative to `sheetId`.' },
          range: { type: 'string', description: 'A1 range within the sheet, e.g. A1:F30 (default A1:Z100).' },
          rowPrefix: { type: 'boolean', description: 'Prefix each CSV row with [row=N] coordinates (default false).' },
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
          required: ['actualRange', 'csv', 'truncated'],
          properties: {
            actualRange: { type: 'string' },
            csv: { type: 'string' },
            truncated: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: [
            `Range ${value.actualRange || '(unknown)'}${value.truncated ? ` (truncated at ${MAX_CSV_CHARS} chars)` : ''}:`,
            value.csv,
          ].join('\n'),
        }],
      },
      async execute(args, exec) {
        const range = str(args.range).trim() || 'A1:Z100'
        const command = [
          'sheets', '+csv-get',
          ...locatorArgs(args),
          ...sheetArgs(args),
          '--range', range,
          args.rowPrefix === true ? '--include-row-prefix' : '--include-row-prefix=false',
          '--json',
          ...identityArgs(runtime, args.as),
        ]
        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const csv = str(data.annotated_csv)
        const truncated = csv.length > MAX_CSV_CHARS
        return {
          actualRange: str(data.actual_range),
          csv: truncated ? csv.slice(0, MAX_CSV_CHARS) : csv,
          truncated,
        }
      },
    },
  ]

  if (settings.readOnly || !settings.allowSheetsWrite) return tools

  tools.push(
    {
      name: 'feishu_sheets_create',
      description:
        'Create a new Feishu spreadsheet, optionally filled with an untyped 2D JSON array of values. ' +
        'Returns the new spreadsheet token and URL.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: { type: 'string', description: 'Spreadsheet title.' },
          values: {
            type: 'array',
            items: { type: 'array', items: { additionalProperties: true } },
            description: 'Optional 2D array of initial values, e.g. [["name","score"],["alice",95]].',
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
          required: ['ok', 'spreadsheetToken', 'url', 'summary'],
          properties: {
            ok: { type: 'boolean' },
            spreadsheetToken: { type: 'string' },
            url: { type: 'string' },
            summary: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args, exec) {
        const title = requireString(args.title, 'title')
        const command = ['sheets', '+workbook-create', '--title', title]
        if (Array.isArray(args.values)) command.push('--values', JSON.stringify(args.values))
        command.push('--json', ...identityArgs(runtime, args.as))
        const parsed = await runCliJson(runtime, command, exec)
        const spreadsheet = parsed.data?.spreadsheet ?? {}
        const token = str(spreadsheet.spreadsheet_token)
        const url = str(spreadsheet.url)
        return {
          ok: parsed.ok !== false,
          spreadsheetToken: token,
          url,
          summary: `Created spreadsheet "${title}"${token ? ` (${token})` : ''}${url ? ` — ${url}` : ''}.`,
        }
      },
    },
    {
      name: 'feishu_sheets_write',
      description:
        'Paste RFC-4180 CSV into a Feishu spreadsheet at a top-left cell (default A1). ' +
        'Values are written as-is; a leading `=` is evaluated as a formula. ' +
        'Overwrites target cells unless `allowOverwrite` is false. The grid auto-expands.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['csv'],
        properties: {
          spreadsheetToken: { type: 'string', description: 'Spreadsheet token from a /sheets/<token> URL.' },
          url: { type: 'string', description: 'Spreadsheet URL. Mutually exclusive with `spreadsheetToken`.' },
          sheetId: { type: 'string', description: 'Sheet id from feishu_sheets_info.' },
          sheetName: { type: 'string', description: 'Sheet title, as an alternative to `sheetId`.' },
          startCell: { type: 'string', description: 'Top-left A1 anchor (default A1).' },
          csv: { type: 'string', description: 'RFC 4180 CSV text (values or formulas).' },
          allowOverwrite: { type: 'boolean', description: 'Allow overwriting non-empty cells (default true).' },
          dryRun: { type: 'boolean', description: 'Preview the request without writing.' },
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
          required: ['ok', 'summary'],
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args, exec) {
        const csv = str(args.csv)
        if (csv.trim() === '') throw new Error('`csv` must be non-empty')
        const startCell = str(args.startCell).trim() || 'A1'
        const command = [
          'sheets', '+csv-put',
          ...locatorArgs(args),
          ...sheetArgs(args),
          '--csv', csv,
          '--start-cell', startCell,
          args.allowOverwrite === false ? '--allow-overwrite=false' : '--allow-overwrite=true',
        ]
        if (args.dryRun === true) command.push('--dry-run')
        command.push('--json', ...identityArgs(runtime, args.as))
        const parsed = await runCliJson(runtime, command, exec)
        const summary = args.dryRun === true
          ? `Dry run: would paste CSV at ${startCell}.`
          : `Wrote CSV at ${startCell}${parsed.data?.range ? ` (${parsed.data.range})` : ''}.`
        return { ok: parsed.ok !== false, summary }
      },
    },
  )

  return tools
}

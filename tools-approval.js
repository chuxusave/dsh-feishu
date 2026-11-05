/**
 * Feishu approval (审批) read tools: my approval tasks and one instance detail.
 *
 * Approving or rejecting is deliberately not exposed: that authority stays with
 * the user in the Feishu client. The tools here only read what is waiting.
 *
 * @module dsh-feishu/tools-approval
 */

import { compactJson, identityArgs, requireString, runCliJson, str } from './cli.js'

/** `--topic` accepts numeric API topics; expose readable names instead. */
const TOPICS = {
  pending: '1',
  done: '2',
  unread_notice: '17',
  read_notice: '18',
}

/** First array found under one of the common envelope keys. */
function firstTaskArray(data) {
  for (const key of ['tasks', 'items', 'results', 'list']) {
    if (Array.isArray(data?.[key])) return data[key]
  }
  return []
}

/** Best-effort field extraction from one approval task row. */
function normalizeTask(task) {
  const raw = task && typeof task === 'object' ? task : {}
  const instance = raw.instance && typeof raw.instance === 'object' ? raw.instance : {}
  return {
    instanceCode: str(raw.instance_code ?? instance.code ?? raw.instanceCode ?? raw.code),
    title: str(raw.title ?? raw.approval_name ?? instance.title ?? instance.approval_name ?? raw.definition_name),
    status: str(raw.status ?? raw.task_status ?? raw.state ?? instance.status),
    definitionCode: str(raw.definition_code ?? raw.approval_code ?? instance.definition_code ?? instance.approval_code),
  }
}

/**
 * Build the approval tools for one settings snapshot.
 *
 * @param {ReturnType<import('./cli.js').buildRuntime>} runtime - runtime facts.
 * @param {ReturnType<import('./settings.js').sanitizeSettings>} settings - validated settings.
 * @returns {Array<Record<string, unknown>>} tool definitions.
 */
export function buildApprovalTools(runtime, settings) {
  return [
    {
      name: 'feishu_approval_tasks',
      description:
        'List the signed-in user\'s Feishu approval (审批) tasks. `topic` selects pending approvals (default), ' +
        'handled approvals, or unread/read notices. Read-only: approving still happens in Feishu.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          topic: {
            type: 'string',
            enum: ['pending', 'done', 'unread_notice', 'read_notice'],
            description: 'Which task list to query (default pending).',
          },
          keyword: { type: 'string', description: 'Search keyword.' },
          limit: { type: 'number', description: 'Page size (1-100, default 20).' },
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
          required: ['count', 'tasks', 'note'],
          properties: {
            count: { type: 'integer' },
            note: { type: 'string' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['instanceCode', 'title', 'status', 'definitionCode'],
                properties: {
                  instanceCode: { type: 'string' },
                  title: { type: 'string' },
                  status: { type: 'string' },
                  definitionCode: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? (value.note ? `No approval tasks parsed. raw: ${value.note}` : 'No Feishu approval tasks matched.')
            : [`${value.count} approval task(s):`,
              ...value.tasks.map((task) => `- ${task.title || '(untitled)'}${task.status ? ` [${task.status}]` : ''}${task.instanceCode ? ` — instance ${task.instanceCode}` : ''}`),
              value.note ? `note: ${value.note}` : ''].filter(Boolean).join('\n'),
        }],
      },
      async execute(args, exec) {
        const topicName = typeof args.topic === 'string' && args.topic in TOPICS ? args.topic : 'pending'
        const limit = Number.isFinite(args.limit) ? Math.min(Math.max(Math.floor(args.limit), 1), 100) : 20
        const command = ['approval', 'tasks', 'query', '--topic', TOPICS[topicName], '--page-size', String(limit), '--json']
        if (typeof args.keyword === 'string' && args.keyword.trim() !== '') command.push('--keyword', args.keyword.trim())
        command.push(...identityArgs(runtime, args.as))
        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const tasks = firstTaskArray(data).map(normalizeTask)
        const note = tasks.length === 0 && Object.keys(data).length > 0 ? compactJson(data, 600) : ''
        return { count: tasks.length, tasks, note }
      },
    },
    {
      name: 'feishu_approval_instance',
      description:
        'Read one Feishu approval instance by its instance code (from feishu_approval_tasks). ' +
        'Returns the instance payload as compact JSON text. Read-only.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['instanceCode'],
        properties: {
          instanceCode: { type: 'string', description: 'Approval instance code (from the task list).' },
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
          required: ['instanceCode', 'summary'],
          properties: {
            instanceCode: { type: 'string' },
            summary: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args, exec) {
        const instanceCode = requireString(args.instanceCode, 'instanceCode')
        const parsed = await runCliJson(runtime, ['approval', 'instances', 'get', '--instance-code', instanceCode, '--json', ...identityArgs(runtime, args.as)], exec)
        return {
          instanceCode,
          summary: `Instance ${instanceCode}:\n${compactJson(parsed.data ?? {}, 4000) || '(empty payload)'}`,
        }
      },
    },
  ]
}

/**
 * Feishu task (待办) tools: list my tasks, create one, complete one.
 *
 * @module dsh-feishu/tools-tasks
 */

import { identityArgs, requireString, runCliJson, str } from './cli.js'

/**
 * Build the task tools for one settings snapshot.
 *
 * @param {ReturnType<import('./cli.js').buildRuntime>} runtime - runtime facts.
 * @param {ReturnType<import('./settings.js').sanitizeSettings>} settings - validated settings.
 * @returns {Array<Record<string, unknown>>} tool definitions.
 */
export function buildTaskTools(runtime, settings) {
  const tools = [
    {
      name: 'feishu_task_list',
      description:
        'List Feishu tasks (待办) assigned to the signed-in user. Filter by `completed` or `query` (summary match). ' +
        'Returns task guid, title, completion state and URLs; use the guid with feishu_task_complete.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'Match task summaries (exact first, then partial).' },
          completed: { type: 'boolean', description: 'true = completed tasks only, false = open tasks only; omit for both.' },
          limit: { type: 'number', description: 'Maximum tasks to return (1-100, default 20).' },
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
          required: ['count', 'hasMore', 'tasks'],
          properties: {
            count: { type: 'integer' },
            hasMore: { type: 'boolean' },
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'summary', 'completed', 'due', 'url'],
                properties: {
                  id: { type: 'string' },
                  summary: { type: 'string' },
                  completed: { type: 'boolean' },
                  due: { type: 'string' },
                  url: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.count === 0
            ? 'No Feishu tasks matched.'
            : [`${value.count} task(s)${value.hasMore ? ' (more available)' : ''}:`,
              ...value.tasks.map((task) => `- ${task.completed ? '[x]' : '[ ]'} ${task.summary} — ${task.id}${task.due ? ` (due ${task.due})` : ''}`)].join('\n'),
        }],
      },
      async execute(args, exec) {
        const limit = Number.isFinite(args.limit) ? Math.min(Math.max(Math.floor(args.limit), 1), 100) : 20
        const command = ['task', '+get-my-tasks', '--page-limit', String(limit), '--json']
        if (args.completed === true) command.push('--complete=true')
        if (args.completed === false) command.push('--complete=false')
        if (typeof args.query === 'string' && args.query.trim() !== '') command.push('--query', args.query.trim())
        command.push(...identityArgs(runtime, args.as))
        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const items = Array.isArray(data.items) ? data.items : []
        const tasks = items.slice(0, limit).map((task) => ({
            id: str(task?.guid ?? task?.task_id ?? task?.id),
            summary: str(task?.summary ?? task?.title),
            completed: task?.completed === true,
            due: str(task?.due?.timestamp ? new Date(Number(task.due.timestamp) < 1e12 ? Number(task.due.timestamp) * 1000 : Number(task.due.timestamp)).toISOString() : task?.due ?? ''),
            url: str(task?.url),
        }))
        return {
          count: tasks.length,
          hasMore: data.has_more === true || items.length > tasks.length,
          tasks,
        }
      },
    },
  ]

  if (settings.readOnly || !settings.allowTaskWrite) return tools

  tools.push(
    {
      name: 'feishu_task_create',
      description:
        'Create a Feishu task (待办). Pass `summary`; optional `due` (ISO 8601, date:YYYY-MM-DD, relative:+2d), ' +
        '`description` and an `assignee` open_id (ou_…). Returns the new task guid.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['summary'],
        properties: {
          summary: { type: 'string', description: 'Task title.' },
          due: { type: 'string', description: 'Due date: ISO 8601, date:YYYY-MM-DD or relative:+2d.' },
          description: { type: 'string', description: 'Task description.' },
          assignee: { type: 'string', description: 'Assignee user open_id (ou_…) or app id (cli_…).' },
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
          required: ['ok', 'taskId', 'summary'],
          properties: {
            ok: { type: 'boolean' },
            taskId: { type: 'string' },
            summary: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args, exec) {
        const summaryText = requireString(args.summary, 'summary')
        const command = ['task', '+create', '--summary', summaryText]
        if (typeof args.due === 'string' && args.due.trim() !== '') command.push('--due', args.due.trim())
        if (typeof args.description === 'string' && args.description.trim() !== '') command.push('--description', args.description)
        if (typeof args.assignee === 'string' && args.assignee.trim() !== '') command.push('--assignee', args.assignee.trim())
        command.push('--json', ...identityArgs(runtime, args.as))
        const parsed = await runCliJson(runtime, command, exec)
        const data = parsed.data ?? {}
        const taskId = str(data.task?.guid ?? data.guid ?? data.task_id ?? data.task?.id)
        return {
          ok: parsed.ok !== false,
          taskId,
          summary: `Created task "${summaryText}"${taskId ? ` (${taskId})` : ''}.`,
        }
      },
    },
    {
      name: 'feishu_task_complete',
      description: 'Mark a Feishu task as complete. Pass the task guid (or its applink URL) from feishu_task_list.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['taskId'],
        properties: {
          taskId: { type: 'string', description: 'Task guid or task applink URL.' },
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
        const taskId = requireString(args.taskId, 'taskId')
        const parsed = await runCliJson(runtime, ['task', '+complete', '--task-id', taskId, '--json', ...identityArgs(runtime, args.as)], exec)
        return { ok: parsed.ok !== false, summary: `Marked task ${taskId} complete.` }
      },
    },
  )

  return tools
}

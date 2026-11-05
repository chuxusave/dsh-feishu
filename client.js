/**
 * Browser half of dsh-feishu: the settings page.
 *
 * It registers one page in the Settings surface (`settings.section`) and talks
 * to the loopback Host routes under `/api/dsh-feishu`. It is hand-written
 * plain-JS (no build step) and relies on the Harness module loader, the seeded
 * React runtime, and the theme tokens.
 */
window.__ModuleLoader__.load({
  id: 'dsh-feishu',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const color = {
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      muted: 'var(--dsw-alias-label-secondary, #57606a)',
      border: 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.28))',
      layer: 'var(--dsw-alias-bg-layer-1, transparent)',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.06))',
      brand: 'var(--dsw-alias-brand-primary, #2f6df6)',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      warn: 'var(--dsw-alias-state-warn-primary, #9a6700)',
      error: 'var(--dsw-alias-state-error-primary, #d1242f)',
      idle: 'var(--dsw-alias-state-idle-primary, #8b949e)',
    }

    const card = {
      border: `1px solid ${color.border}`,
      borderRadius: 10,
      padding: '14px 16px',
      background: color.layer,
      marginBottom: 14,
    }

    const label = {
      display: 'block',
      fontSize: 12,
      color: color.muted,
      marginBottom: 6,
    }

    const input = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '7px 10px',
      fontSize: 13,
      color: color.text,
      background: color.layer2,
      border: `1px solid ${color.border}`,
      borderRadius: 8,
      outline: 'none',
    }

    const row = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '7px 0',
    }

    const button = {
      padding: '7px 14px',
      fontSize: 13,
      fontWeight: 600,
      borderRadius: 8,
      border: `1px solid ${color.border}`,
      background: 'transparent',
      color: color.text,
      cursor: 'pointer',
    }

    const primaryButton = { ...button, background: color.brand, borderColor: color.brand, color: '#fff' }
    const mutedButton = { ...button, color: color.muted }

    /** One status pill. */
    function Pill(props) {
      const tone = props.ok === true ? color.ok : props.ok === 'warn' ? color.warn : color.idle
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 12,
          color: props.muted ? color.muted : tone,
          marginRight: 14,
        },
      }, h('span', {
        style: { width: 7, height: 7, borderRadius: 999, background: props.muted ? color.idle : tone },
      }), props.text)
    }

    /** A labelled native select. */
    function Select(props) {
      return h('select', {
        value: props.value,
        disabled: props.disabled,
        onChange: (event) => props.onChange(event.target.value),
        style: { ...input, appearance: 'auto' },
      }, props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
    }

    /** A checkbox row. */
    function Checkbox(props) {
      return h('label', {
        style: { ...row, cursor: props.disabled ? 'default' : 'pointer', opacity: props.disabled ? 0.55 : 1 },
      }, h('span', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
        h('span', { style: { fontSize: 13, color: color.text } }, props.text),
        props.hint ? h('span', { style: { fontSize: 12, color: color.muted } }, props.hint) : null,
      ), h('input', {
        type: 'checkbox',
        checked: props.checked === true,
        disabled: props.disabled,
        onChange: (event) => props.onChange(event.target.checked),
        style: { width: 16, height: 16, accentColor: color.brand },
      }))
    }

    /** POST a JSON payload; throws with the Host's message on failure. */
    async function post(url, payload) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body && body.error ? body.error : `HTTP ${response.status}`)
      return body
    }

    /** The settings page registered into `settings.section`. */
    function FeishuSettings() {
      const [status, setStatus] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [advanced, setAdvanced] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)

      const refresh = React.useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch('/api/dsh-feishu/status', { cache: 'no-store' })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
          setStatus(body)
          setForm(body.settings)
        } catch (error) {
          setNotice({ kind: 'error', text: `读取状态失败：${String(error.message || error)}` })
        } finally {
          setBusy(false)
        }
      }, [])

      React.useEffect(() => {
        void refresh()
      }, [refresh])

      const set = (key) => (value) => setForm((current) => ({ ...(current ?? {}), [key]: value }))

      const save = async () => {
        if (!form) return
        setBusy(true)
        setNotice(null)
        try {
          const body = await post('/api/dsh-feishu/settings', form)
          setStatus((current) => ({ ...(current ?? {}), settings: body.settings, tools: body.tools }))
          setForm(body.settings)
          setNotice({ kind: 'success', text: `已保存并立即生效，当前注册 ${body.tools} 个工具。` })
        } catch (error) {
          setNotice({ kind: 'error', text: `保存失败：${String(error.message || error)}` })
        } finally {
          setBusy(false)
        }
      }

      const test = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const body = await post('/api/dsh-feishu/test', {})
          setStatus((current) => ({ ...(current ?? {}), cli: body.cli, ok: body.cli.ok }))
          setNotice({ kind: body.cli.ok ? 'success' : 'error', text: body.cli.ok ? 'lark-cli 连接正常。' : `lark-cli 检查未通过：${body.cli.message || '见上方状态'}` })
        } catch (error) {
          setNotice({ kind: 'error', text: `测试失败：${String(error.message || error)}` })
        } finally {
          setBusy(false)
        }
      }

      if (!form) {
        return h('div', { style: { padding: '10px 2px', color: color.muted, fontSize: 13 } },
          busy ? '正在读取 lark-cli 状态…' : (notice ? notice.text : '暂无数据'),
          h('div', { style: { marginTop: 10 } }, h('button', { type: 'button', style: button, onClick: refresh }, '重新读取')),
        )
      }

      const cli = (status && status.cli) || {}
      const readOnly = form.readOnly === true
      const disabled = busy
      const setField = (key) => (event) => set(key)(event.target.value)

      return h('div', { style: { maxWidth: 720, color: color.text, fontSize: 13 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 } },
          h('div', null,
            h('div', { style: { fontSize: 15, fontWeight: 600 } }, '飞书（lark-cli）'),
            h('div', { style: { fontSize: 12, color: color.muted, marginTop: 2 } },
              `通过本机已登录的 lark-cli 使用飞书：消息、云文档、多维表格、日历。v${(status && status.version) || '?'}`),
          ),
          h('div', null,
            h(Pill, { ok: cli.ok === true, text: cli.ok === true ? '连接就绪' : '需要处理' }),
          ),
        ),

        h('div', { style: card },
          h('div', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginBottom: 8 } },
            h(Pill, { ok: cli.bot === 'pass', text: `bot ${cli.bot || 'unknown'}` }),
            h(Pill, { ok: cli.user === 'pass', text: `user ${cli.user || 'unknown'}` }),
            h(Pill, { ok: cli.api === 'pass', text: `API ${cli.api || 'unknown'}` }),
          ),
          h('div', { style: { fontSize: 12, color: color.muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', wordBreak: 'break-all' } },
            `CLI: ${cli.resolved || cli.path || form.larkCliPath}`),
          cli.message ? h('div', { style: { marginTop: 8, fontSize: 12, color: color.error, wordBreak: 'break-word' } }, cli.message) : null,
          h('div', { style: { marginTop: 8, fontSize: 12, color: color.muted } },
            '未登录或缺少权限时，在终端运行 `lark-cli auth login`，或按工具报错里的提示补充 scope。'),
        ),

        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 12 } }, '连接与身份'),
          h('div', { style: { marginBottom: 12 } },
            h('label', { style: label }, '默认身份'),
            h(Select, {
              value: form.identity,
              disabled,
              onChange: set('identity'),
              options: [
                { value: 'auto', label: 'auto（由 lark-cli 决定）' },
                { value: 'bot', label: 'bot（机器人）' },
                { value: 'user', label: 'user（我的用户身份）' },
              ],
            }),
            h('div', { style: { fontSize: 12, color: color.muted, marginTop: 4 } },
              '发消息默认用 bot；读文档、读表格一般都能用 user。'),
          ),
          h('div', { style: { marginBottom: 12 } },
            h('label', { style: label }, 'lark-cli 路径'),
            h('input', { style: input, value: form.larkCliPath, disabled, onChange: setField('larkCliPath'), placeholder: 'lark-cli 或 /opt/homebrew/bin/lark-cli' }),
          ),
          h('div', null,
            h('label', { style: label }, '单次调用超时（毫秒）'),
            h('input', {
              style: input,
              type: 'number',
              min: 5000,
              max: 600000,
              step: 1000,
              value: form.timeoutMs,
              disabled,
              onChange: (event) => set('timeoutMs')(Number(event.target.value)),
            }),
          ),
        ),

        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '写入权限'),
          h(Checkbox, {
            text: '只读模式',
            hint: '开启后不注册任何写工具：发消息、写多维表格、建日程都会消失。',
            checked: readOnly,
            disabled,
            onChange: set('readOnly'),
          }),
          h(Checkbox, {
            text: '允许发送消息',
            hint: 'feishu_send_message；真实发送要求机器人在目标会话里。',
            checked: form.allowSendMessage === true,
            disabled: disabled || readOnly,
            onChange: set('allowSendMessage'),
          }),
          h(Checkbox, {
            text: '允许写多维表格',
            hint: 'feishu_base_upsert_record 会新建或更新记录。',
            checked: form.allowBaseWrite === true,
            disabled: disabled || readOnly,
            onChange: set('allowBaseWrite'),
          }),
          h(Checkbox, {
            text: '允许创建日程',
            hint: 'feishu_calendar_create 会真的建日程并邀请参会人。',
            checked: form.allowCalendarWrite === true,
            disabled: disabled || readOnly,
            onChange: set('allowCalendarWrite'),
          }),
          h(Checkbox, {
            text: '允许写表格',
            hint: 'feishu_sheets_create / feishu_sheets_write 会新建表格或改写单元格。',
            checked: form.allowSheetsWrite === true,
            disabled: disabled || readOnly,
            onChange: set('allowSheetsWrite'),
          }),
          h(Checkbox, {
            text: '允许创建/完成待办',
            hint: 'feishu_task_create / feishu_task_complete 会改你的飞书待办。',
            checked: form.allowTaskWrite === true,
            disabled: disabled || readOnly,
            onChange: set('allowTaskWrite'),
          }),
        ),

        h('div', { style: { marginBottom: 14 } },
          h('button', {
            type: 'button',
            style: mutedButton,
            onClick: () => setAdvanced((value) => !value),
          }, advanced ? '收起高级设置' : '高级设置'),
        ),

        advanced ? h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: 12 } }, '高级'),
          h('div', null,
            h('label', { style: label }, '工作目录（留空 = 用户主目录）'),
            h('input', { style: input, value: form.workdir, disabled, onChange: setField('workdir'), placeholder: '例如 /Users/you/feishu-work' }),
            h('div', { style: { fontSize: 12, color: color.muted, marginTop: 4 } },
              'lark-cli 子进程的 cwd；相对路径下载会落在这里。'),
          ),
        ) : null,

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
          h('button', { type: 'button', style: primaryButton, disabled: busy, onClick: save }, busy ? '处理中…' : '保存并应用'),
          h('button', { type: 'button', style: button, disabled: busy, onClick: test }, '测试连接'),
          h('button', { type: 'button', style: mutedButton, disabled: busy, onClick: refresh }, '重新读取'),
          notice ? h('span', {
            style: { fontSize: 12, color: notice.kind === 'error' ? color.error : color.ok, wordBreak: 'break-word' },
          }, notice.text) : null,
        ),

        h('div', { style: { marginTop: 16, fontSize: 12, color: color.muted, lineHeight: 1.6 } },
          h('div', null, `配置文件：${(status && status.settingsPath) || '(unknown)'}`),
          h('div', null, `当前注册工具数：${(status && status.tools) || 0}`),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'feishu-lark-cli', order: 30, label: '飞书' },
          FeishuSettings,
        ))
      },
    }
  },
})

# dsh-feishu

给 **DeepSeek Harness**（DSH，DeepSeek 官方 AI 编码客户端）用的飞书/Lark 插件：把你本机**已登录的 `lark-cli`** 包成 DSH 原生工具。

- 不存任何凭证：app secret、user token 全部留在 `lark-cli` 自己的 profile / macOS 钥匙串里。
- 不经过 shell：参数以数组直接传给子进程，没有引号注入问题。
- 一装即用：默认零配置；装好 `lark-cli` 并登录过就能用。

## 提供的工具

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `feishu_status` | 体检：`lark-cli` 是否可达、bot / user 身份是否就绪 | 只读 |
| `feishu_find_chats` | 按关键字搜群，或列出已加入的会话，拿到 `chat_id` | 只读 |
| `feishu_search_docs` | 搜云文档 / Wiki / 表格 / 多维表格，返回标题和链接 | 只读 |
| `feishu_read_doc` | 把一个 DOCX 或 Wiki 文档读成 Markdown | 只读 |
| `feishu_send_message` | 发文本 / Markdown 到群或私聊，支持 `dryRun` 预览 | 写 |

## 前置条件

1. **DSH**（插件随 profile 生效，装一次全局可用）。
2. **Node.js ≥ 20**（DSH 自带）。
3. **lark-cli**（飞书官方 CLI）：
   ```bash
   npm i -g @larksuite/cli
   lark-cli auth login        # 按提示完成一次授权
   lark-cli doctor            # 看到 bot/user 身份 ready 即可
   ```
4. 发消息时：应用需具备 `im:message:send_as_bot` 权限，且机器人已在目标会话里。

## 安装

在 DSH 里任选一种：

**让 DSH 自己装**（推荐，直接对这个插件说）：

> 帮我安装 `github:chuxusave/dsh-feishu` 这个 bundle

**命令行 / Web 插件页**：

- Web：侧栏 **Plugins** → 安装 bundle → 填 `github:chuxusave/dsh-feishu`
- 或 `plugin_manager` 工具 `action: install_bundle`, `target: github:chuxusave/dsh-feishu`

**本地开发（link 安装）**：把 `target` 换成这个目录的绝对路径，改完源码由 HMR 热重载。

装完即生效（live profile），重启 DSH 也会保留。

## 配置（可选）

默认什么都不用配。要改就在 profile 的 `cordis.patch.yml` 里覆盖这一行：

```yaml
- id: feishu
  name: dsh-feishu
  config:
    larkCliPath: /opt/homebrew/bin/lark-cli
    readOnly: false
    timeoutMs: 60000
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `larkCliPath` | `lark-cli` | CLI 路径。GUI 启动的 DSH 可能没有 Homebrew 的 PATH，插件会自动去 `/opt/homebrew/bin`、`/usr/local/bin`、`~/.npm-global/bin` 等位置找；找不到时填绝对路径。 |
| `searchDirs` | `[]` | 追加的 CLI 搜索目录。 |
| `workdir` | 用户主目录 | 子进程工作目录（影响相对路径下载）。 |
| `timeoutMs` | `60000` | 单次调用超时。 |
| `readOnly` | `false` | `true` 时不注册 `feishu_send_message`，只留只读工具。 |

## 身份与权限

`lark-cli` 支持 bot 和 user 两种身份：

- **bot**（默认更稳）：发消息需要应用有 `im:message:send_as_bot`，且机器人在会话里。
- **user**：发消息需要额外授权 `im:message.send_as_user`：
  ```bash
  lark-cli auth login --scope "im:message.send_as_user"
  ```
- 读文档、搜文档、搜群通常 user 身份已够。

工具失败时会把 `lark-cli` 自己的 `error.message` 和 `hint` 原样带回，照着提示补 scope 或换身份即可。

## 安全说明

- 插件不读取、不落盘任何 secret；授权全由 `lark-cli` 管理。
- 写操作只有一个 `feishu_send_message`，建议首次先 `dryRun: true` 预览。
- 不需要写能力时设 `readOnly: true`，发送工具根本不会出现在工具列表里。

## 实测

- `feishu_status`、`feishu_find_chats`、`feishu_search_docs`、`feishu_read_doc`：在 lark-cli 1.0.98 + 飞书自建应用下全部通过。
- `feishu_send_message`：`dryRun` 通过；真实发送要求机器人已在目标会话，且应用开启了 `im:message:send_as_bot`（用 user 身份发则还需 `im:message.send_as_user`）。
- 错误会以 lark-cli 原文消息返回，例如文档不存在时：`Invalid document_id or document not found...`。

## 卸载

```text
plugin_manager action=remove_bundle target=dsh-feishu
```

## 为什么是插件而不是 skill

Skill 教模型「怎么用 CLI」，工具调用仍要走 bash；插件把动作变成带 schema 的原生工具——可以看到工具列表、可以被 DSH 的权限/审批策略约束、可以跨会话复用到别的 profile，也能直接发布给别人一键安装。

## 开发

```bash
node --check index.js   # 语法检查
```

- `index.js`：Host 半边，注册工具；无构建步骤、零运行时依赖。
- `cordis.patch.yml`：bundle 补丁，插入 `feishu` 这一行。
- `locale/en.json`、`locale/zh.json`、`icon.svg`：插件管理页的标题、描述和图标。

## License

MIT

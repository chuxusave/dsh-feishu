# dsh-feishu

给 **DeepSeek Harness**（DSH）用的飞书/Lark 插件：把你本机**已登录的 `lark-cli`** 包成 DSH 原生工具，并带一个 Web 设置页。

- 不存任何凭证：app secret、user token 全部留在 `lark-cli` 自己的 profile / macOS 钥匙串里。
- 不经过 shell：参数以数组直接传给子进程，没有引号注入问题。
- 一装即用：装好 `lark-cli` 并登录过就能用；身份、只读、写入开关都在设置页里点。

## 提供的工具

**消息与云文档**

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `feishu_status` | 体检：`lark-cli` 是否可达、bot / user 身份是否就绪 | 只读 |
| `feishu_find_chats` | 按关键字搜群，或列出已加入的会话，拿到 `chat_id`；外部租户的群会标 `[外部群]`（自建应用发不进去） | 只读 |
| `feishu_search_docs` | 搜云文档 / Wiki / 表格 / 多维表格，返回标题和链接 | 只读 |
| `feishu_read_doc` | 把一个 DOCX 或 Wiki 文档读成 Markdown | 只读 |
| `feishu_send_message` | 发文本 / Markdown / 图片 / 文件 / 视频到群或私聊，支持 `dryRun` 预览；视频自动用 ffmpeg 抽首帧做封面 | 写 |

**多维表格（Base）**

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `feishu_base_tables` | 列出某个 Base 里所有数据表（id、名称、记录数） | 只读 |
| `feishu_base_fields` | 列出某张表的字段（id、名称、类型），写记录前先看 | 只读 |
| `feishu_base_list_records` | 按字段名读出记录，支持 filter / sort JSON、分页、字段投影 | 只读 |
| `feishu_base_upsert_record` | 新建或更新一条记录（字段名 → 值） | 写 |

**日历**

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `feishu_calendar_agenda` | 看日程（默认今天，可传起止时间） | 只读 |
| `feishu_calendar_freebusy` | 查忙闲 / 空闲窗口（busy、free、common_free、raw_busy） | 只读 |
| `feishu_calendar_create` | 建日程并邀请参会人，支持 `dryRun` | 写 |

**表格（Sheets）**

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `feishu_sheets_info` | 列出表格的子表（sheet_id、标题、行列数），做任何表格操作前先看 | 只读 |
| `feishu_sheets_read` | 按 A1 范围把表格读成 CSV | 只读 |
| `feishu_sheets_create` | 新建表格，可带初始 2D 数据 | 写 |
| `feishu_sheets_write` | 把 CSV 从指定单元格粘进表格（支持公式） | 写 |

**待办（Tasks）**

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `feishu_task_list` | 列出分配给我的待办，可按完成状态/标题过滤 | 只读 |
| `feishu_task_create` | 新建待办（截止时间、描述、指派人） | 写 |
| `feishu_task_complete` | 把一条待办标记完成 | 写 |

**审批（Approvals，只读）**

| 工具 | 作用 | 风险 |
| --- | --- | --- |
| `feishu_approval_tasks` | 查我的审批任务：待办 / 已处理 / 未读|已读通知 | 只读 |
| `feishu_approval_instance` | 查单个审批实例详情 | 只读 |

> 审批只开放读：批准/拒绝仍在飞书里由你本人操作。

所有工具都接受 `as` 参数（`auto` / `bot` / `user`）覆盖默认身份。

## 设置页

安装后在 **设置 → 飞书** 打开（DSH 0.2 也在 Plugins 页可进入），可以：

- 查看 `lark-cli` 是否就绪、bot / user / API 三项检查结果、实际解析到的 CLI 路径
- 改默认身份（auto / bot / user）、CLI 路径、超时、工作目录
- 只读模式：一键关掉所有写工具（发消息、写 Base、建日程直接不注册）
- 分别开关「发送消息」「写多维表格」「创建日程」「写表格」「创建/完成待办」
- 「测试连接」直接跑一次 `lark-cli doctor`

保存后**立即生效**，不用重启 DSH。设置写在 `~/.dsh/dsh-feishu.settings.json`（有 `DSH_PROFILE_DIR` 时写在该 profile 目录，权限 0600），也可以手动编辑。

> **从 0.1.x 升级**：DSH 会把旧版本「没有浏览器半边」的判定缓存到重启，所以升级后设置页要**重启一次 DSH** 才会出现。全新安装不需要这一步。

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

### 额外权限（scope）

日历、审批、部分写入默认没有授权，第一次调用会返回 lark-cli 的原始提示，照着执行即可：

```bash
# user 身份：日历读 + 建日程
lark-cli auth login --scope "calendar:calendar.event:read calendar:calendar.event:create calendar:calendar.event:update"

# user 身份：读我的审批任务（feishu_approval_tasks / _instance 需要）
lark-cli auth login --scope "approval:task:read"
```

bot 身份则需要在飞书开发者后台给应用申请对应 scope（工具报错里会给出带 clientID 的申请链接）。

多维表格 / 表格 / 待办的写入权限同理：按工具返回的 missing scope 提示补充授权。

## 安装

在 DSH 里任选一种：

**让 DSH 自己装**：

> 帮我安装 `github:chuxusave/dsh-feishu` 这个 bundle

**Web 插件页 / 命令行**：

- Web：侧栏 **Plugins** → 安装 bundle → 填 `github:chuxusave/dsh-feishu`
- 或 `plugin_manager` 工具 `action: install_bundle`, `target: github:chuxusave/dsh-feishu`

**本地开发（link 安装）**：把 `target` 换成这个目录的绝对路径。改完源码需要重新安装一次（uninstall + install）才会加载新的 JS 模块。

### 如果 `github:` 安装报连接超时

DSH 在安装前会对 GitHub 做一次连通性检查（默认 5 秒），网络慢或被代理拦截时会报
`connection to github.com timed out after 5000ms`。两种办法：

1. 调大超时（profile 的 `cordis.patch.yml`）：

   ```yaml
   - id: plugin-manager
     name: "@deepseek-ai/dsh-plugin-manager"
     config:
       githubConnectionTimeoutMs: 30000
   ```

2. 或克隆后按本地路径安装：

   ```bash
   git clone https://github.com/chuxusave/dsh-feishu.git
   # 把 clone 出来的目录绝对路径作为 install_bundle 的 target
   ```

## 安全说明

- 插件不读取、不落盘任何 secret；授权全由 `lark-cli` 管理。
- 设置页走 `/api/dsh-feishu/*`，只接受本机回环请求（并校验浏览器同源标记），不对局域网开放。
- 写工具默认全开，但可以先 `dryRun`，也可以开只读模式彻底关掉。
- 子进程参数是数组直传，不拼 shell 字符串。

## 实测

- `feishu_status`、`feishu_find_chats`、`feishu_search_docs`、`feishu_read_doc`：lark-cli 1.0.98 + 飞书自建应用，全部通过。
- `feishu_base_tables` / `feishu_base_fields` / `feishu_base_list_records`：对真实多维表格读通（字段名 → 记录对象）。
- `feishu_send_message`、`feishu_calendar_create`：`dryRun` 通过；真实调用要求对应 scope 与会话成员关系。
- **媒体发送验证过（bot 身份）**：`feishu_send_message` 发视频到内部群成功（`msg_type=media`，自动抽帧封面）；图片/文件同理。**user 身份发媒体不行**：本租户管理员禁止了 `im:resource:upload`（不可申请），bot 身份不受影响，但机器人必须已在目标群里。
- **表格（Sheets）全链路验证过**：`feishu_sheets_create` 建表 → `feishu_sheets_info` 列出子表 → `feishu_sheets_write` 从 A4 写入两行 → `feishu_sheets_read` 读回一致 → 删除测试表格。
- **待办（Tasks）全链路验证过**：`feishu_task_list` 读出真实待办 → `feishu_task_create` 建测试待办（返回 guid）→ `feishu_task_complete` 标记完成 → 删除测试待办。
- **审批（Approvals）**：只读工具已就位；当前账号缺 `approval:task:read` scope，报错会带出授权命令。
- **多维表格写入全链路验证过**：临时新建一个 Base（Tasks 表）→ `feishu_base_upsert_record` 新建记录 → `feishu_base_list_records` 读回 → 按 `recordId` 把 Status 更新为 Done → 再读回确认 → 删除测试 Base。临时数据已清理。
- **日历三件套在真实账号上全链路验证过**：建日程 → `feishu_calendar_agenda` 看到该日程 → `feishu_calendar_freebusy` 显示该时段被占用 → 删除后 agenda 回到「日程清空」。scope 授权（device flow）也走通了。
- 设置接口 `/api/dsh-feishu/status|settings|test` 已实测：只读模式一键从 12 个工具切到 9 个、再切回来；`client.js` 的插槽注册在真实页面里验证过（注册为「飞书」设置页）。受限于环境没有浏览器控制，页面视觉效果未人工确认。
- 日历读接口需要先补 `calendar:calendar.event:read`，未授权时报错会带出 lark-cli 的授权命令。

## 卸载

```text
plugin_manager action=remove_bundle target=dsh-feishu
```

## 为什么是插件而不是 skill

Skill 教模型「怎么用 CLI」，工具调用仍要走 bash；插件把动作变成带 schema 的原生工具——可以看到工具列表、可以被 DSH 的权限/审批策略约束、可以跨会话复用，还能在设置页里改配置，也能直接发布给别人一键安装。

## 开发

```bash
for f in index.js cli.js settings.js routes.js tools-*.js client.js; do node --check "$f"; done
```

- `index.js`：Host 半边入口，装配工具与路由，设置变更时重建工具集。
- `cli.js`：`lark-cli` 子进程封装（`execFile`、JSON 信封解析、错误提示透传）。
- `settings.js`：设置读写与校验（JSON、0600）。
- `routes.js`：设置页的 `/api/dsh-feishu/*` 路由（回环 + 同源校验）。
- `tools-messaging.js` / `tools-base.js` / `tools-calendar.js`：三组工具定义。
- `client.js`：浏览器半边，注册 **设置 → 飞书** 页面（手写 plain-JS，无构建步骤）。
- `locale/en.json`、`locale/zh.json`、`icon.svg`：插件管理页的标题、描述和图标。

## License

MIT

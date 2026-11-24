# uniostr

个人自用的本地 Nostr Relay：接收、校验、存储、查询事件，支持订阅推送、白名单、可选远端同步与本地维护命令。

- 运行时：Node.js（`tsx` 直接运行 TypeScript 源码）
- 语言：TypeScript（`tsc --noEmit` 静态检查）
- 存储：SQLite（better-sqlite3，WAL 模式）
- 网络：Node.js 原生 `http` + `ws`
- 密码学：`@noble/curves` schnorr 验签，`node:crypto` 计算事件 ID

## 功能概览

| 能力 | 状态 |
| --- | --- |
| NIP-01 事件、过滤查询、订阅、`OK` / `EOSE` / `CLOSED` / `NOTICE` | 已实现 |
| 可替换事件 kind 0/3/10000-19999、临时事件 20000-29999 | 已实现 |
| NIP-33 可寻址事件 kind 30000-39999（按 `d` 标签替换） | 已实现 |
| NIP-09 删除（`e` / `a` 标签 + tombstone） | 已实现 |
| NIP-40 过期（拒收过期事件、查询排除） | 已实现 |
| NIP-42 AUTH 与写入白名单 | 已实现 |
| NIP-11 Relay 信息文档 | 已实现 |
| 标签索引（回复 / 互动 / 关注等关系查询） | 已实现 |
| 远端 Relay 单向全量同步（白名单作者） | 已实现 |
| 本地按 id 删除命令 | 已实现 |
| COUNT（NIP-45）、NIP-50 搜索、Negentropy、双向同步 | 未实现 |

## 环境要求

- Node.js >= 22（已在 Node.js 26 上验证）
- Windows / macOS / Linux 均可，无需 Python、Go、Rust、Docker

## 快速开始

```powershell
npm install        # 安装依赖
npm run dev        # 启动 Relay（tsx 直接运行 src/main.ts）
npm run typecheck  # 静态类型检查
npm test           # 单元 + WebSocket 集成测试
```

启动后连接 `ws://127.0.0.1:7777` 即可。状态检查：

```powershell
curl.exe http://127.0.0.1:7777/health
```

`Ctrl+C` 退出：先停止远端同步与 HTTP/WebSocket 服务，再关闭数据库连接。

首次启动会自动生成 `config.json`、创建 `data/` 与 `logs/` 目录，并初始化/迁移 SQLite 结构。

> 浏览器内的网页客户端通常要求 `wss://`，直连本地 `ws://` 可能被混合内容策略拦截，建议使用桌面/移动客户端或命令行工具。

## 配置（config.json）

```json
{
  "host": "127.0.0.1",
  "port": 7777,
  "database": "./data/relay.db",
  "logLevel": "info",
  "allowedPubkeys": [],
  "requireAuth": false,
  "remoteRelay": ""
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `host` | string | HTTP / WebSocket 监听地址 |
| `port` | number | 监听端口，1-65535 |
| `database` | string | SQLite 文件路径，相对路径基于工作目录 |
| `logLevel` | `debug` \| `info` \| `warn` \| `error` | 日志级别 |
| `allowedPubkeys` | string[] | 写入白名单（64 位 hex 公钥），空数组表示不限制 |
| `requireAuth` | boolean | 为 true 时，连接必须完成 NIP-42 认证才能读写 |
| `remoteRelay` | string | 远端公开 Relay 地址（`ws://` / `wss://`），空字符串表示不启用同步 |

`allowedPubkeys`、`requireAuth`、`remoteRelay` 可省略，缺省为 `[]` / `false` / `""`；配置类型或格式非法时启动失败并给出明确错误。修改配置后需重启生效。

### 白名单与认证组合

| `allowedPubkeys` | `requireAuth` | 写入 | 读取 |
| --- | --- | --- | --- |
| 空 | false | 所有人 | 所有人 |
| 非空 | false | 仅白名单公钥 | 所有人 |
| 空 | true | 任意完成 AUTH 的公钥 | 任意完成 AUTH 的公钥 |
| 非空 | true | 白名单公钥且已认证 | 仅白名单公钥（需认证） |

非白名单公钥的 `AUTH` 会被拒绝；事件作者以签名验证后的 `pubkey` 为准，而不是连接身份。

## 服务端点

| 地址 | 说明 |
| --- | --- |
| `GET /` | 运行状态 JSON；带 `Accept: application/nostr+json` 时返回 NIP-11 文档 |
| `GET /health` | 运行状态 JSON |
| `ws://127.0.0.1:7777/` | Nostr Relay WebSocket 入口（任意路径均可连接） |

NIP-11 文档包含 `supported_nips: [1, 9, 11, 33, 40, 42]`、`software`、`version`，以及
`max_message_length: 524288`、`auth_required`（跟随配置）。

## 目录结构

```
src/
  main.ts                 程序入口，仅负责启动应用
  config/config.ts        配置读取、默认生成、校验
  app/app.ts              生命周期：启动 / 资源释放 / 信号处理
  relay/server.ts         HTTP 与 WebSocket 服务
  relay/handler.ts        协议处理：校验、入库、订阅、广播、AUTH
  relay/remote-sync.ts    远端 Relay 单向同步（实时订阅 + 历史回溯）
  protocol/event.ts       事件类型、ID 计算、签名校验、kind 分类
  protocol/filter.ts      filter 校验/规范化与内存匹配
  protocol/auth.ts        NIP-42 AUTH 事件校验
  protocol/message.ts     客户端消息解析与出站消息序列化
  storage/database.ts     SQLite 连接封装
  storage/schema.ts       表结构与迁移（PRAGMA user_version）
  storage/events.ts       事件写入、查询、替换、删除
  storage/sync-state.ts   远端同步进度持久化
  tools/delete-event.ts   本地按 id 删除事件的维护命令
  utils/logger.ts         统一日志输出
test/                     node:test 单元与集成测试
data/                     SQLite 数据文件目录
logs/                     日志目录（预留）
```

## 数据库

`events` 表：`id`（主键）、`pubkey`、`created_at`、`kind`、`content`、`tags`（JSON 字符串）、`sig`，
以及写入时冗余的 `d_tag`、`expires_at`。

`event_tags` 表：`(event_id, name, value)`，随事件写入/替换/删除自动维护，`#e`、`#p`、`#t` 等标签查询走索引。

索引：`(pubkey, created_at)`、`(kind, created_at)`、`(created_at)`、`(pubkey, kind, created_at)`、
`event_tags (name, value, event_id)`。

其他表：

- `deleted_events`：按 id 的 tombstone；
- `deleted_coordinates`：可寻址坐标的 tombstone；
- `sync_state`：远端同步进度（`backfill_complete`、`backfill_cursor`、`last_seen`）。

结构升级使用 `PRAGMA user_version` + `src/storage/schema.ts` 的顺序迁移列表，不引入 ORM 或迁移框架。

## 协议行为

- `EVENT`：结构校验 → 白名单 → ID 与 schnorr 签名校验 → 入库/替换/删除。
  成功 `OK true ""`；重复 `duplicate: ...`；签名或 ID 错误 `invalid: ...`；已删除或白名单外 `blocked: ...`；
  未认证 `auth-required: ...`。
- `REQ`：filter 之间 OR、字段之间 AND；支持 `ids` / `authors`（hex 前缀）、`kinds`、`since` / `until`、
  `#<tag>` 和 `limit`（缺省 500、上限 5000）；先发送历史 `EVENT`，再发送 `EOSE`，随后登记订阅实时推送。
  非法 filter 或未认证返回 `CLOSED`。
- `CLOSE`：移除订阅，无回复。
- `AUTH`：连接建立时下发 challenge；客户端提交 kind 22242 事件（`challenge` / `relay` 标签，±10 分钟窗口）。
- `COUNT`：未实现，返回 `NOTICE`。
- 单条 WebSocket 消息上限 512 KiB；无法解析或结构非法的消息返回 `NOTICE`。

事件语义：

- 可替换事件按 `(pubkey, kind)` 保留最新，同时间戳保留 id 字典序较小者；
- 可寻址事件按 `(pubkey, kind, d)` 保留最新；
- 临时事件（20000-29999）只推送不落库；
- 过期事件拒绝写入，查询与推送时排除；
- NIP-09 只能删除同作者事件，删除后写 tombstone 阻止重新入库。

## 远端同步

配置 `remoteRelay` 后，程序与该远端建立长期 WebSocket 连接，只订阅 `allowedPubkeys` 中的作者，
拉取这些作者的全部 kind 事件（NIP-01 全部字段原样入库）：

- 实时订阅：连接后立即建立，按 `lastSeen - 5 分钟` 作为 `since`，每 60 秒刷新一次；
- 历史回溯：按 `until` 游标分页拉取历史（默认每页 500 条），直到某页不足一页；
- 进度写入 `sync_state`，重启后断点续传，不会重复全量回溯；
- 远端事件重新做结构校验、白名单过滤、ID/签名验证，再交给 `EventStore` 去重入库；
- 断线 5 秒后自动重连；`allowedPubkeys` 为空时不同步；
- 远端要求 AUTH 时忽略（只读同步）。

该同步是单向、按作者拉取，不做双向同步、Negentropy；历史分页依赖远端按 `created_at` 倒序返回，
同一秒内超过一页的事件可能被跳过。

## 本地按 id 删除

```powershell
npm run delete -- <64 位 hex 事件 id>
```

- 事务内删除事件行与 `event_tags` 索引，并写入 `deleted_events` tombstone；
- 事件不存在时也写 tombstone，避免远端同步之后重新拉回；
- 不校验作者，属于本地所有者维护操作；程序运行时执行也安全（SQLite WAL 支持并发）；
- 协议内删除仍应使用 NIP-09（kind 5，仅作者本人可删）。

## 测试

```powershell
npm test  # 34 项
```

覆盖：事件 ID/签名校验、filter 语义、存储去重/替换/过期/NIP-09/标签索引、本地删除 tombstone、
HTTP NIP-11、WebSocket 订阅与推送、AUTH/白名单、远端同步分页与状态持久化、配置校验。

## 尚未实现与已知限制

- COUNT/NIP-45、NIP-50 搜索、Negentropy、双向 Relay 同步、多用户权限体系、管理 API / Web 界面。
- 不在 Relay 侧验证 NIP-05 域名；`nip05` 仅作为 kind 0 内容原样存储。
- 不主动物理清理过期事件，只在写入/查询时排除。
- AUTH 身份未强制绑定事件作者（作者以签名公钥为准）。
- 远端同步不做内容级合并，只按事件 id 去重；同一秒内超过一页的事件可能漏拉。

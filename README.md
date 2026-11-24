# uniostr

个人自用的本地 Nostr Relay。

- 运行时：Node.js（开发使用 tsx 直接运行 TypeScript 源码）
- 语言：TypeScript（`tsc --noEmit` 做静态类型检查）
- 存储：SQLite（better-sqlite3）
- 网络：Node.js 原生 `http` + `ws`
- 密码学：`@noble/curves` schnorr 验签，`node:crypto` 计算事件 ID

已实现：NIP-01（事件校验/存储/过滤查询/订阅/OK/EOSE）、可替换事件（kind 0/3/10000-19999）、
可寻址事件（NIP-33，kind 30000-39999）、临时事件（kind 20000-29999）、NIP-40 过期、
NIP-09 删除、NIP-42 AUTH 与写入白名单、NIP-11 Relay 信息文档。
标签查询使用独立 `event_tags` 索引表，支持回复、互动、关注等关系类查询。
可选从指定远端公开 Relay 单向拉取白名单作者的事件（长连接 + 定时补拉）。

## 环境要求

- Node.js >= 22（已在 Node.js 26 上验证）
- Windows / macOS / Linux 均可，无需 Python、Go、Rust、Docker

## 安装与运行

```powershell
npm install       # 安装依赖
npm run dev       # 以 tsx 直接运行 src/main.ts
npm run typecheck # 静态类型检查
npm test          # node:test 单元 + 集成测试
```

按 `Ctrl+C` 退出，程序会先关闭 WebSocket / HTTP 服务与数据库连接再退出。

首次启动会自动生成 `config.json`、创建 `data/` 与 `logs/` 目录，并初始化/迁移 SQLite 结构。

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

`allowedPubkeys`、`requireAuth`、`remoteRelay` 可省略，缺省为 `[]` / `false` / `""`。配置类型非法时启动会失败并输出明确错误。

## 服务端点

| 地址 | 说明 |
| --- | --- |
| `GET /` | 运行状态 JSON；带 `Accept: application/nostr+json` 时返回 NIP-11 Relay 信息文档 |
| `GET /health` | 返回运行状态 JSON |
| `ws://127.0.0.1:7777/` | Nostr Relay WebSocket 入口（任意路径均可连接） |

## 目录结构

```
src/
  main.ts                 程序入口，仅负责启动应用
  config/config.ts        配置读取、默认生成、校验
  app/app.ts              生命周期：启动 / 资源释放 / 信号处理
  relay/server.ts         HTTP 与 WebSocket 服务
  relay/handler.ts        协议处理：校验、入库、订阅、广播、AUTH
  relay/remote-sync.ts    远端 Relay 单向拉取（长连接 + 定时补拉）
  protocol/event.ts       事件类型、ID 计算、签名校验、kind 分类
  protocol/filter.ts      filter 校验/规范化与内存匹配
  protocol/auth.ts        NIP-42 AUTH 事件校验
  protocol/message.ts     客户端消息解析与出站消息序列化
  storage/database.ts     SQLite 连接封装
  storage/schema.ts       表结构与迁移（PRAGMA user_version）
  storage/events.ts       事件写入、查询、替换、删除
  utils/logger.ts         统一日志输出
test/                     node:test 单元与集成测试
data/                     SQLite 数据文件目录
logs/                     日志目录（预留）
```

## 数据库

`events` 表：`id`（主键）、`pubkey`、`created_at`、`kind`、`content`、`tags`（JSON 字符串）、`sig`，
以及写入时冗余的 `d_tag`、`expires_at`（用于可寻址事件与过期查询）。

`event_tags` 表：`(event_id, name, value)`，随事件写入/替换/删除自动维护，`#e`、`#p`、`#t` 等标签查询走索引。

索引：`(pubkey, created_at)`、`(kind, created_at)`、`(created_at)`、`(pubkey, kind, created_at)`、
`event_tags (name, value, event_id)`。

删除记录：`deleted_events`（按 id 的 tombstone）与 `deleted_coordinates`（可寻址坐标的 tombstone）。

`sync_state` 表：记录每个远端 Relay 的历史回溯进度（`backfill_complete` / `backfill_cursor`）与 `last_seen`。

结构升级使用 `PRAGMA user_version` + `src/storage/schema.ts` 的顺序迁移列表，不引入 ORM 或迁移框架。

## 协议行为

- `EVENT`：校验 ID 与 schnorr 签名后入库；重复事件返回 `OK true "duplicate: ..."`，
  签名/ID 错误返回 `OK false "invalid: ..."`，已删除/白名单返回 `OK false "blocked: ..."`。
- `REQ`：filter 之间为 OR、字段之间为 AND；`limit` 缺省 500、上限 5000；先发送历史 `EVENT`，再发送 `EOSE`，
  随后登记订阅用于实时推送。非法 filter 或未认证返回 `CLOSED`。
- `CLOSE`：移除订阅，无回复。
- `AUTH`：连接建立时下发 challenge；客户端提交 kind 22242 事件（`challenge` / `relay` 标签，±10 分钟窗口）。
- `COUNT`：本轮未实现，返回 `NOTICE`。
- 无法解析或结构非法的消息返回 `NOTICE`。

可替换事件按 `(pubkey, kind)` 保留最新（同时间戳保留 id 字典序较小者）；可寻址事件按
`(pubkey, kind, d)` 保留最新；临时事件只推送不落库；过期事件拒绝写入并在查询中排除。

## 远端同步

配置 `remoteRelay` 后，程序会与远端 Relay 建立一条长期 WebSocket 连接，只订阅
`allowedPubkeys` 中的作者，拉取这些作者的全部 kind 事件（NIP-01 全部字段原样入库）：

- 实时订阅：连接后立即建立，持续接收新事件，按 `lastSeen - 5 分钟` 作为 `since`；
- 历史回溯：按 `until` 游标分页拉取完整历史（默认每页 500 条），直到某页不足一页为止；
- 同步进度写入 `sync_state` 表，重启后从断点续传，不会重复全量回溯；
- 远端推送的事件会重新做结构校验、白名单过滤、ID/签名验证，再交给 `EventStore` 去重入库；
- 断线 5 秒后自动重连；`allowedPubkeys` 为空时不会同步（避免拉取全量公共数据）；
- 远端要求 AUTH 时忽略（只读同步），远端限制只读访问时同步会失败并记录日志。

该同步是单向、按作者拉取，不做双向同步、Negentropy；历史分页依赖远端按 `created_at` 倒序返回，
同一秒内超过一页的事件可能被跳过。

## 尚未实现

COUNT/NIP-45、NIP-50 搜索、Negentropy、双向 Relay 同步、多用户权限体系、管理 API / Web 界面。

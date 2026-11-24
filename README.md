# uniostr

个人自用的本地 Nostr Relay 基础工程（第一阶段）。

- 运行时：Node.js（开发使用 tsx 直接运行 TypeScript 源码）
- 语言：TypeScript（`tsc --noEmit` 做静态类型检查）
- 存储：SQLite（better-sqlite3）
- 网络：Node.js 原生 `http` + `ws`

当前阶段只完成可运行的基础骨架：配置加载、日志、数据库初始化、HTTP / WebSocket 服务、
Nostr 消息类型识别。**不包含**签名校验、事件存储、订阅、EOSE、NIP-09/33/40/42、
白名单、Relay 同步等协议功能。

## 环境要求

- Node.js >= 22（已在 Node.js 26 上验证）
- Windows / macOS / Linux 均可，无需 Python、Go、Rust、Docker

## 安装与运行

```powershell
npm install      # 安装依赖
npm run dev      # 以 tsx 直接运行 src/main.ts
npm run typecheck # 静态类型检查
```

按 `Ctrl+C` 退出，程序会先关闭 WebSocket / HTTP 服务与数据库连接再退出。

首次启动会自动完成：

- 生成 `config.json`（默认 `127.0.0.1:7777`，数据库 `./data/relay.db`，日志级别 `info`）
- 创建 `data/`、`logs/` 目录（若不存在）
- 创建 SQLite 数据库文件并初始化 `events` 表与索引

## 配置（config.json）

```json
{
  "host": "127.0.0.1",
  "port": 7777,
  "database": "./data/relay.db",
  "logLevel": "info"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `host` | string | HTTP / WebSocket 监听地址 |
| `port` | number | 监听端口，1-65535 |
| `database` | string | SQLite 文件路径，相对路径基于工作目录 |
| `logLevel` | `debug` \| `info` \| `warn` \| `error` | 日志级别 |

配置缺失或类型非法时，启动会失败并输出明确的错误信息。

## 服务端点

| 地址 | 说明 |
| --- | --- |
| `GET http://127.0.0.1:7777/` 或 `/health` | 返回运行状态 JSON |
| `ws://127.0.0.1:7777/` | Nostr Relay WebSocket 入口（任意路径均可连接） |

## 目录结构

```
config.json               自动生成的运行配置
src/
  main.ts                 程序入口，仅负责启动应用
  config/config.ts        配置读取、默认生成、校验
  app/app.ts              生命周期：启动 / 资源释放 / 信号处理
  relay/server.ts         HTTP 与 WebSocket 服务
  relay/handler.ts        WebSocket 消息入口，交给协议层解析
  storage/database.ts     SQLite 连接封装
  storage/schema.ts       表结构与迁移（PRAGMA user_version）
  protocol/message.ts     Nostr 消息类型定义与基础识别
  utils/logger.ts         统一日志输出
data/                     SQLite 数据文件目录
logs/                     日志目录（预留）
```

## 数据库

`events` 表字段：`id`（主键）、`pubkey`、`created_at`、`kind`、`content`、`tags`（JSON 字符串）、`sig`。

基础索引：`(pubkey, created_at)`、`(kind, created_at)`、`(created_at)`。

结构升级使用 `PRAGMA user_version` + `src/storage/schema.ts` 中的顺序迁移列表，
不引入 ORM 或迁移框架。当前只建表，不写入任何事件。

## 消息识别

客户端发送的文本帧按 JSON 数组解析，支持的识别类型：`EVENT`、`REQ`、`CLOSE`、`AUTH`、`COUNT`。
识别成功后仅记录日志（不包含内容、不返回 OK/EOSE）；无法解析时返回 `["NOTICE", "..."]` 并记录警告。

## 当前阶段尚未实现

事件签名与 ID 校验、事件存储/删除/替换、REQ Filter 执行、订阅管理、EOSE、完整 OK 语义、
NIP-09/33/40/42/50、COUNT 统计、白名单、Relay 同步、Negentropy、管理 API / Web 界面。

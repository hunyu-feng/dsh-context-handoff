# dsh-context-handoff 本地开发备忘

给"在这台机器上继续开发它的人"看的：当前挂在哪、改完怎么生效、怎么验证、有哪些坑。
面向使用者的说明在 [README.md](./README.md)。

## 它是什么

DSH 的上下文守卫插件，两半协作：

- 宿主半 `index.js`：`inject = ['webServer', 'tokenMeter', 'llm']`，监听 `session/event`，
  用 `tokenMeter.measure` 和模型的 contextWindow 算出每个活跃会话的占用比例（内存里最多跟踪
  64 个会话），并暴露两个同源路由：
  - `GET /context-handoff/api/state?sessionId=<id>` → 当前占用（未跟踪的会话返回 404 `session not tracked`）
  - `POST /context-handoff/api/brief` → 让当前模型写一份 ≤800 字的交接说明
- 客户端半 `client.js`：输入框下方胶囊（`上下文 42.1%` + 绿/黄/红进度），到阈值时依次
  `sessions.create()` → `prompt()` 发摘要 → `uiWorkspace.openSession()` 自动切过去。

- 包名 / 目录名 / 仓库名：`dsh-context-handoff`
- 仓库：https://github.com/hunyu-feng/dsh-context-handoff
- **零运行时依赖**（不 import 任何包，只用宿主注入的 ctx），所以在任何 profile 里都能直接装。

## 本地挂载状态（desktop profile）

- 源码目录：`C:\Users\wang7\Documents\deepseek-harness\default-workspace\dsh-context-handoff`
- `package.json` 依赖：`"dsh-context-handoff": "link:C:/Users/wang7/Documents/deepseek-harness/default-workspace/dsh-context-handoff"`
- `dsh.profile.bundles` 中包含 `dsh-context-handoff`
- `cordis.patch.yml` 的 entry id 仍是 `context-handoff`（有意保留，避免和按 id 匹配的 override 失配），
  只有 `name` 是包名。

## 配置

| 位置 | 键 | 默认 |
| --- | --- | --- |
| bundle 配置 | `threshold` | `0.85` |
| 环境变量 | `HANDOFF_THRESHOLD` | —— |

阈值会被 clamp 到 `0.5–0.98`；每个会话只自动触发一次交接，手动点「立即交接」不受限制。

## 改完代码怎么生效（最容易踩的坑）

**禁用再启用插件不会重新加载代码。** DSH 用 ESM 加载，模块缓存按绝对路径算。

- 宿主半改动：重启 DSH 宿主；或换目录名后 `remove_bundle` + `install_bundle`
  （target 传 `file:<新绝对路径>`）；或用 dev 副本（复制目录、改 `package.json` name 与
  `cordis.patch.yml` 的 id/name、`node_modules` 软链）。
- 客户端半改动：宿主重启后**刷新页面**；只刷新页面不会拿到新的 `client.js`。

## 怎么验证

本插件没有单元测试，验证靠在 GUI 里跑：

```bash
# 宿主半路由是否注册（未跟踪的会话应返回 404 + JSON 错误，而不是 HTML 404）
curl -s "http://127.0.0.1:62053/context-handoff/api/state?sessionId=probe"
# => {"ok":false,"error":"session not tracked"}
```

GUI 里：输入框下方出现「上下文 xx%」胶囊；点「立即交接」应该新建会话、自动发送交接摘要并切过去。

## 已知限制

- 只跟踪"有过 session 事件"的会话；刚打开、还没说话的会话测不到占用（返回 404 是正常的）。
- 交接摘要走当前模型通道，摘要本身会消耗 token；模型不可用时交接失败，需要手动重试。
- contextWindow 靠 `ctx.llm.resolveModelInfo()`，provider/model 未知时退到 1,000,000 的兜底值，
  此时百分比只是估计。
- 自动交接依赖客户端 API（`sessions.create` / `uiWorkspace.openSession`）；宿主侧 API 变动会先在这里坏。

## 改名历史

- 2026-10-22：包名 `dsh-plugin-context-handoff` → `dsh-context-handoff`，目录 `context-handoff` →
  `dsh-context-handoff`，并首次建 git 仓库 / 推 GitHub。路由 `/context-handoff/api/*` 与 entry id
  保持原样。

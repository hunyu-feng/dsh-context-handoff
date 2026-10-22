# Context Handoff · 上下文交接

> 本地开发备忘（怎么改、改完怎么生效、踩过的坑）：见 [NOTES.md](./NOTES.md)。

给 DSH / DPH Agent 的上下文守卫插件：实时显示当前会话的上下文占用，接近上限时自动把工作**交接给一个新会话**，先由模型写出交接摘要，再让新会话直接接着干，并自动切过去。

## 功能

- **实时占用**：输入框下方显示 `上下文 42.1%` 与进度条，绿 / 黄 / 红三档。
- **到阈值自动交接**（默认 85%，每个会话只触发一次）：
  1. 让当前模型把"用户目标 / 已完成 / 未完成 / 下一步"写成 ≤800 字交接说明；
  2. 新建一个空白会话（同一工作区、同一 Agent 预设）；
  3. 把交接说明作为第一条消息发给新会话，它会直接开始干活；
  4. 界面自动切到新会话。
- **手动交接**：点一下胶囊里的「立即交接」，随时换会话。
- **失败可重试**：摘要失败或新建会话失败会显示原因，点「重试」。

## 阈值

默认 `85%`。改环境变量 `HANDOFF_THRESHOLD`（0.5–0.98）后重启 DSH 生效，或在 bundle 配置里传 `threshold`。

## 安装

本地开发安装：

```bash
dsh plugin install /path/to/dsh-context-handoff
```

或通过 `plugin_manager` 的 `install_bundle` 指向本目录。安装后重启 DSH，输入框下方出现「上下文 xx%」即生效。

## 两个半边

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `index.js` | 监听 `session/event` 测上下文压力（`tokenMeter.measure` / 模型 contextWindow）；`/context-handoff/api/state` 返回占用；`/context-handoff/api/brief` 调当前模型写交接摘要 |
| Client | `client.js` | 输入框 dock 胶囊；到阈值时取摘要 → `sessions.create()` → `prompt()` 发摘要 → `uiWorkspace.openSession()` 切会话 |

## 数据与隐私

- 不写任何数据库；只在内存里跟踪最近 64 个活动会话的 token 数。
- 摘要由你当前配置的模型生成，走的是本机 DSH 的模型通道，不额外上传。
- 不修改会话历史；旧会话原样保留，可随时回去看。

## 文件

```
dsh-context-handoff/
├── index.js            host 插件
├── client.js           UI 插件
├── cordis.patch.yml    bundle 补丁
├── locale/{en,zh}.json 插件标题/描述
├── NOTES.md            本地开发备忘（怎么改、怎么生效、坑）
├── LICENSE
└── icon.svg
```

MIT License.

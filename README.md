<div align="center">

# Memo

**随手记下待办，把 Codex 的工作进展带回备忘录。**

本机网页 · Markdown 文件 · Claude Agent SDK · Codex Stop Hook

[快速开始](#快速开始) · [接入-codex](#接入-codex) · [数据与配置](#数据与配置)

<img src="docs/preview.png" alt="Memo 本地页面，包含自然语言输入、待办列表和 Codex 更新建议" width="880">

<sub>界面中的记录为示例数据。</sub>

</div>

## 一句话怎么变成记录

> 明天验证一下支付回调，登录超时那个已经搞定了。

Memo 会直接新增「验证支付回调」，把到期日设为明天，再给已有的「修复登录超时」生成一条完成建议。命中多个待办时，先选中对应的记录再确认。

| 入口 | 处理方式 |
| --- | --- |
| 网页输入 | Claude 即时提取笔记和待办，匹配已有事项 |
| Codex 项目 | 每轮结束时把最后一条回复存入本地收件箱 |
| 每日汇总 | 默认 21:00 整理已授权的 Codex 回复，生成带来源的待确认建议 |
| 每日提醒 | 默认 09:00 通过 macOS 通知提醒到期或逾期的待办和待确认项 |

## 快速开始

需要 macOS、Node.js 22.22+ 和 Anthropic API Key。

```bash
git clone https://github.com/Underdog-RJ/memo.git
cd memo
npm ci
cp .env.example .env
chmod 600 .env
```

在 `.env` 中填写 `ANTHROPIC_API_KEY`，然后启动服务。

```bash
npm run build
npm start
```

打开 [http://127.0.0.1:4317](http://127.0.0.1:4317)。在页面的「设置」中可以切换 Claude 模型、修改提醒和汇总时间。

关闭网页后，服务仍继续运行。若希望 Mac 登录后自动启动，先停止手动启动的服务，再执行：

```bash
npm run login -- enable
```

关闭登录启动时执行 `npm run login -- disable`。首次使用时，可在 macOS 通知设置中允许对应通知。若登录启动在 Desktop 等受保护目录遇到访问限制，可将项目放到普通开发目录，再重新启用登录启动。

## 接入 Codex

1. 打开 Memo 的「设置」，添加本机项目的绝对路径。Worktree 需要单独添加对应目录。
2. 如需自动生成建议，为该项目勾选「允许模型处理」，然后保存。
3. 复制页面里的 Codex Hook 配置，将其中的 `Stop` 条目合并到项目的 `.codex/hooks.json`。已有 Hook 可以保留。
4. 在 Codex 中审阅并信任 Hook。跑完新的一轮后，回到 Memo，点击「立即汇总」或等到定时时间。

采集从启用后的新回复开始。每轮只取最后一条回复的片段，并按会话和轮次去重。汇总失败时，回复留在收件箱，可在页面重试。详情见 [Codex Stop Hook](https://learn.chatgpt.com/docs/hooks#stop)。

## 数据与配置

| 位置 | 内容 |
| --- | --- |
| `~/Library/Application Support/Memo/备忘录.md` | 可直接打开或备份的 Markdown 导出 |
| 同目录下的 `state.json` | 记录、设置、待确认建议与汇总进度 |
| 同目录下的 `codex/` | 采集的 Codex 回复片段 |
| 项目内的 `.env` | Anthropic API Key 和可选的本地配置 |

通过网页编辑记录，应用会同步刷新 Markdown。可在 `.env` 中设置 `MEMO_DATA_DIR` 来指定数据目录，或用 `MEMO_PORT` 修改端口。迁移数据目录后，记得从设置页重新复制 Hook 配置。

网页提交的文本、相关待办和你授权的 Codex 片段会交给 Anthropic 推理。API Key 由本地服务读取。服务只监听本机回环地址。

## 开发验证

```bash
npm test
```

测试用替身模型验证新增、模糊匹配、人工确认、Codex Hook 去重、汇总重试、定时补跑和本地请求限制。真实推理需要配置 Anthropic API Key。

```text
网页输入 ──────────────┐
                      ├─ Claude Agent SDK ── 备忘录 / 待确认建议
Codex Hook ── 本地收件箱 ┘
```

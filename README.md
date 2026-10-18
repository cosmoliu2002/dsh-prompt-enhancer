# 提示词增强器（dsh-prompt-enhancer）

一个 DeepSeek Harness 插件：把输入框里还没想清楚的草稿，一键扩写成**可直接发送的结构化提示词**，并在发送前列出「待确认」的信息缺口。

## 是什么

- 只做一次**廉价模型 one-shot 调用**，不创建会话轮次、不写模型历史。
- Host 半注册两个 slash 命令；Client 半在输入框旁提供 ✨ 按钮。
- 结果分两部分：改写后的提示词（可直接用）＋ 原稿缺失、值得先确认的问题（`gaps`）。

## 两个入口

| 入口 | 命令 | 返回 |
| --- | --- | --- |
| ✨ 按钮（client.js） | `/enhance-quiet <draft>` | `JSON.stringify({prompt, gaps, added})` 字符串，供按钮解析后回填输入框 |
| 手动 slash 命令 | `/enhance <draft>` | 纯文本：改写后的提示词；有缺口时追加 `## 待确认` / `## To confirm` 列表 |

`/enhance-quiet` 是内部命令，按钮调用后命令卡会被隐藏，不打扰会话流。

增强成功后，输入框下方会出现一条诊断条：说明模型补充了什么、列出「待确认」缺口；点「撤销」可恢复原稿（编辑器自身的 Ctrl+Z 也会尽量生效，但用诊断条更可靠）。发送消息后诊断条自动消失。

## 配置项

配置写在 profile 的 `cordis.patch.yml` 中该插件行的 `config` 下；全部可选，非法值回退默认。**默认不钉模型：增强调用跟随当前会话模型。**

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `commandName` | `enhance` | 文本命令名（需匹配 `^[a-z][a-z0-9_-]*$`） |
| `quietCommandName` | `enhance-quiet` | 内部 JSON 命令名 |
| `provider` | 空 | 模型 route；与 `model` 成对出现才生效（省略即跟随会话） |
| `model` | 空 | 模型 id；与 `provider` 成对 |
| `systemPrompt` | 内置 | 要求模型只输出 `{"prompt","gaps","added"}` JSON 的系统提示词 |
| `template` | `Draft:\n<<<\n{{draft}}\n>>>` | 用户消息模板，`{{draft}}` 会被草稿替换 |
| `maxInputChars` | `4000` | 草稿字符上限 |
| `maxOutputTokens` | `1024` | 单次输出 token 上限 |
| `timeoutMs` | `60000` | 单次调用超时（毫秒） |

模型路由解析顺序（「跟随当前会话模型」= 第 2 步）：

1. `config.provider` + `config.model`（成对显式指定时才有，优先级最高）；
2. **当前会话模型**：`modelSelection` 会话投影 —— 编辑器里刚切换、尚未发送的选择（pending）优先，其次是该会话最近一次请求实际使用的模型（last used）；
3. 会话最近一次请求记录的 route（`session.requestHeader().config`）；
4. Agent 创建时的模型选项（`agent.options`）；
5. `ctx.agentDefaultModel.currentSelection()`（设置里的默认模型）。

都没有时命令返回双语错误提示，不会静默失败。想在某个 profile 里固定用廉价模型，只在该 profile 的 patch 中给这行加 `provider` + `model` 成对配置即可。

## 已知限制

- 两个命令都会在会话日志中写入成对的 `command/run` / `command/done` 事件（生命周期记录，正常行为）。
- 按钮路径使用 `/enhance-quiet`，命令卡由 client 半隐藏；直接手敲该命令仍会出现在会话流里。
- 每次增强都会额外消耗一次模型调用（输入草稿 + 输出 prompt/gaps/added）。
- 依赖一个可用模型路由；离线、未配置凭据或 provider 未注册时会返回错误文本。
- 默认跟随会话模型：会话用的是强模型时，增强调用也用它（更慢/更贵）；想要「主对话用强模型、增强用廉价模型」，在该 profile 的 patch 里给这行加 `provider` + `model` 即可。
- 模型输出不是合法 JSON 时不报错：整段输出会作为 prompt 兜底。

## 安装

### 从 GitHub 安装（公开仓库）

```sh
dsh plugin --profile web add git+https://github.com/cosmoliu2002/dsh-prompt-enhancer.git
```

安装后刷新页面即可看到输入框旁的 ✨（Host 行热加载 + Client bundle 热挂载）。

> npm 上同名的 `dsh-prompt-enhancer` 属于另一个项目，本插件的安装源是上面的 GitHub 仓库（或插件市场条目），请不要用 `dsh plugin add dsh-prompt-enhancer` 安装 npm 包。

### 通过插件市场

- **内置「发现」标签页**（实验性自定义插件市场）：把下面的索引 URL 添加为索引源即可浏览/安装：
  `https://raw.githubusercontent.com/cosmoliu2002/dsh-prompt-enhancer/main/market/index.json`
- **dsh-market / awesome-dsh-plugin 社区目录**：仓库已向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交收录条目（`data/plugins/cosmoliu2002__dsh-prompt-enhancer.yml`），合并后会在 dsh-market 里出现并支持一键安装。

### 本地开发安装

以本地目录为 bundle 用 `plugin_manager` 的 `install_bundle` 安装（或把本目录 link 进 profile）；安装即生效（Host 行热重载 + Client bundle 由 client-modules 热挂载）：

1. 包内 `cordis.patch.yml` 的 `insert` 行挂载 Host 半（id `prompt-enhancer`）；
2. `package.json` 的 `dsh.client` 声明让 web app 加载 `client.js`；
3. 默认跟随当前会话模型；需要钉死模型时，在该 profile 的 `cordis.patch.yml` 里按 id 覆盖该行的 `config`（`provider` + `model` 成对）。

## 目录结构

```
index.js            Host 半：命令注册 + one-shot LLM + 结果解析（零 import）
client.js           Client 半：✨ 按钮 + 诊断条 + 隐藏按钮命令卡
cordis.patch.yml    bundle 的 Loader 行
locale/{en,zh}.json 插件管理页标题与描述
icon.svg            插件图标
market/index.json   format-1 插件市场索引（内置「发现」标签页用）
LICENSE             MIT
README.md           本文件
```

## 开发自测

```bash
node --check index.js
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"
```

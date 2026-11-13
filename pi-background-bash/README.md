# pi-background-bash

独立的 Pi 扩展：让模型把 Bash 命令放到后台，完成后自动唤醒当前会话。

仅使用 Pi 的公开 API 和 Node 内置模块，没有额外运行时依赖。执行、shell 配置、会话环境、前台输出格式、进程树终止都复用 Pi 原生 Bash 后端；不修改 Pi Web、模型 provider、认证、提示词处理或全局设置。

## 安装

现与 `pi-error-retry` 在[统一仓库](../README.md)管理。本地开发目录：`~/pi-dev/pi-extensions-shuyuan/pi-background-bash`。

从 GitHub 一次安装两个扩展：

```bash
pi install git:github.com/librola/pi-extensions-shuyuan
```

仅安装本扩展时：

```bash
# 加入全局 Pi 包列表；此命令会修改 ~/.pi/agent/settings.json
pi install ~/pi-dev/pi-extensions-shuyuan/pi-background-bash
```

随后在 Pi 中执行 `/reload`，或新开会话。Pi Web 也从同一份 Pi 包配置加载扩展；正在运行的会话需 reload 或重新打开。

只在一次 CLI 启动中试用，不改全局设置：

```bash
pi -e ~/pi-dev/pi-extensions-shuyuan/pi-background-bash/src/index.ts
```

不要与原来的独立包重复加载，也不要同时加载其他替换 `bash` 执行逻辑的扩展；替换工具不能自动组合。`!` / `!!` 用户 shell 命令保持 Pi 原生行为，本扩展只接管模型调用的 `bash`。

## Web 端（扩展版 Pi Web API v1）

同一个包同时声明 `pi.extensions` 和 `piWeb`。CLI 只加载原生入口；你在 `/data/repos/pi-web/hkk/pi-web-ext` 中提供的 Web 扩展宿主加载浏览器入口和受限桥接，不需要修改或重新构建 Pi Web。

1. 用上面的本地路径安装命令登记为持久 Pi 包，CLI 与 Web 服务使用同一个 agent 目录。
2. 如果原生实例尚不支持 `0.2.x` 公共协议，先停止需要保留的活动任务，再执行原生 `/reload`；原生 reload 会清理本插件的活动任务。`0.2.1` 的顶部计数兼容已加载的 `0.2.0` 实例，只更新 Web 资源即可，无须重启正在运行的任务。
3. Web 端重新聚焦、使用 Web Reload 或刷新页面，发现新版 `piWeb` 资源。Web Reload 不替代原生 reload，也不会重启任务引擎。

### 顶部下拉框

- 入口放在顶部 **工具** 后面的 **后台任务 1 ▾**，不注册侧栏面板、不打开右侧标签、不挤占聊天宽度。
- 无需展开即可看到当前会话正在执行的后台任务数量，每 2 秒自动只读更新。只统计 `background && running`，不包含前台命令或已完成任务；已确认没有后台任务时显示 0，未运行/未加载兼容实例或查询失败时不显示数字，不把历史 `running` 当作当前数量。切换会话不会复用上个会话的数量。
- 点击展开；点击外部、收起按钮或 Esc 关闭。Esc 被下拉框消费，不会误触主 agent 的停止快捷键。
- 展开时只读会话历史，并每 2 秒轻量同步已保存的完成记录。历史中的 `running` 只显示“当前状态未确认”，不会假装跨重启恢复了进程。
- **刷新任务** 查询已加载原生实例的真实状态；点击任务读取当前输出。Web 输出最多末尾 200 行 / 16 KiB，完整日志路径仍可供原生 `read` 读取。
- **开启实时刷新** 后，才每 2 秒查询详细进程状态和当前输出；关闭下拉框时清理详情轮询，顶部数量继续更新。隐藏页面时不发请求，恢复可见立即刷新数量，禁用 Web 时释放全部轮询。
- **停止任务**、**转入后台** 都先确认，再操作当前会话已有的任务。视图失效不意味着操作被撤销，不会自动重试写操作。
- 浏览器中的 `/bash-jobs` 展开同一个下拉框，不发模型提示。原生 CLI 的 `/bash-jobs` 仍显示任务列表。
- 自有格式的工具结果和完成消息有专用卡片；“查看后台任务”打开顶部下拉框。原始内容保留可见，不接管其他插件的同名工具。

查询不启动 AgentSession、不调用模型、不写上下文。没有活动或兼容的原生实例时，界面仅展示历史并提示原生 reload；缺失目标不会回落为模型提示。关闭或仅禁用 Web 展示不会停止原生任务。

浏览器使用宿主 React 和主题变量，所有资源为预构建原生 ESM。下拉框使用浏览器顶层 popover，旧 Safari 回退为原生 dialog，避开移动工具栏的裁剪；输出只按文本展示，不执行 HTML。CLI `-e` 临时加载不是持久包声明，不会触发自动 Web 发现。

### 公共桥接协议

原生扩展在当前会话事件总线上提供 `pi-background-bash:rpc:v1:request`，按请求 ID 回到 `pi-background-bash:rpc:v1:reply:<requestId>`。版本 1 的方法为 `ping`、`list`、`status`、`output`、`stop`、`background`；不接受任意 shell 命令、文件路径或其他会话的任务。

Web 桥动作均要求 `session: active`；查询只能用前四个方法，写操作单独声明。顶部 `count` 动作复用原生 `list`，只返回 `{ running: N }`，不增加原生方法、不启动实例、不向浏览器发送完整任务列表或日志。每次操作都先校验原生实例报告的版本、会话身份、格式和能力，兼容范围为 `>=0.2.0 <0.3.0`。后台工具和完成记录附带 `pi-background-bash.job.v1` 格式标识供安全匹配。后端桥是独立单文件，不在浏览器资产白名单中，也不导入或重写执行引擎。

## 模型调用

```js
// 短命令直接返回；默认等待 30 秒，未完成则移交后台，不重新启动命令。
bash({ command: "npm test" })

// 立即后台执行。
bash({ command: "npm test", background: true })

// 等待 5 秒后转后台；包括后台运行在内，最多执行 10 分钟。
bash({ command: "npm test", timeout: 5, hard_timeout: 600 })
```

`timeout` 是 **TUI/RPC 的前台等待期限**，不是强制终止期限。`hard_timeout` 才会终止进程树，默认不设置。

后台返回包含：

```json
{
  "status": "running",
  "job_id": "job-0123abcd",
  "output": "当前输出摘要",
  "truncated": false,
  "full_output_path": "/tmp/pi-background-bash-xxxxxx/job-0123abcd.log",
  "wall_time_seconds": 0
}
```

运行中的任务 **没有 `exit_code`**；不会用 0 或 124 伪造执行结果。普通前台完成保留 Pi 原生的 `structuredContent` 和非零退出错误标记，codemode 可以使用同样的字段。

### 可选的状态和输出查询

```js
bash_jobs({ action: "list" })
bash_jobs({ action: "status", id: "job-0123abcd" })
bash_jobs({ action: "output", id: "job-0123abcd", tail: 100 })
bash_jobs({ action: "stop", id: "job-0123abcd" })
```

- `list`：当前会话的运行中任务及最近 20 个完成任务；命令预览最多 200 字符。
- `status`：立即返回状态、真实退出码（如果存在）、起止时间、日志大小和路径，不等待任务完成。
- `output`：立即返回已经产生的输出，默认末尾 200 行，最多 2000 行 / 32 KiB，并给出完整日志路径。
- `stop`：用 Pi 原生的进程树终止方式停止任务；Linux/macOS 使用 SIGKILL，不承诺优雅退出。

状态包括 `running`、`completed`、`failed`、`stopped`、`timed_out`、`output_limit`。只有后端报告实际退出码时才提供 `exit_code`。

查询是可选的点时检查，不是等待机制。任务完成后，扩展发送一次 `pi-background-bash:completion` 自定义消息，带任务 ID、状态、退出码、耗时、日志路径及末尾 20 行 / 4 KiB 摘要：

- 模型空闲时：先保存可见完成记录，再用隐藏的唤醒指针启动后续一轮。
- 模型正在工作时：完成记录以 `triggerTurn: false` 交给 SDK，在当前工具调用和结果都落盘后的安全 `turn_end` 写入历史。唤醒等待自然 `agent_settled`，不会打断其他工具，也不依赖可被清除的 follow-up 队列保存事实。
- 主运行被 Stop / Esc 中止时：保留完成记录，取消待唤醒；任务若在 Stop 后才完成，也只保存结果，不重新启动模型。下一次正常运行后恢复自动唤醒，旧待唤醒不会补发。
- 同一轮内的多个完成任务合并唤醒一次，指针最多保存最近 20 个任务 ID；完成记录本身不会因此截尾。隐藏的 `pi-background-bash:wakeup` 只引用已保存的结果，不重复展示完成卡片。
- 没有其他工作时：模型结束当前回复，等待通知；不需要反复 `sleep`、轮询状态或读取日志。

忙碌时可见记录要到安全边界才能写入，不承诺进程崩溃前一定落盘。`0.2.2` 修复了 Stop 清队丢通知和 Stop 后意外唤醒的边界；已被旧版本丢弃的历史消息不会自动重写或补发。

扩展不伪造用户输入。输出和通知中的日志必须作为命令数据处理，不能当作新的指令。

### 手动移交

- `/bash-bg [任务ID]`：把指定或最近启动的前台命令移交后台。
- `Ctrl+Shift+B`：移交最近启动的前台命令（CLI 终端需支持此按键编码）。
- `/bash-jobs`：显示任务列表。

命令移交后台后会解除与原工具调用 AbortSignal 的关联，因此之后按 Esc 不会误杀已经移交的后台任务；停止后台任务请使用 `bash_jobs action=stop`。

## 生命周期和边界

- 任务属于当前会话实例；其他会话不能凭 ID 查询或停止它。
- 关闭会话、reload、新建/切换会话或树导航时，终止原实例的活动任务，禁止旧任务通知进入新上下文。
- 第一版**不跨进程重启恢复任务，也不跨 reload 保留活动任务**。旧日志仍可按原路径读取，但不会恢复到新实例的任务列表。直接使用 SDK 的宿主应先分发 `session_shutdown` 再 `dispose()`；单独 `dispose()` 不是本扩展的清理通知。
- 日志位于系统临时目录，权限 0600；每个命令最多写入 64 MiB，超过后立即终止。已淘汰记录的日志仍保留，由系统临时目录清理；运行大量任务时需要留意磁盘空间。
- 每个会话最多同时运行 16 个命令。任务、命令前缀和环境使用当前宿主配置；不会把 `shellCommandPrefix` 的内容暴露到任务通知，也不把 `PI_WEB_PASSWORD` 传给子进程。
- 不要用 `nohup`、`setsid` 或末尾 `&` 手工脱离进程树；直接使用 `background: true`。主动守护进程化的后代不在可靠追踪范围，宿主崩溃或被 SIGKILL 也不承诺清理。
- print / JSON 是短生命周期模式，无法保证完成后唤醒：拒绝显式 `background: true`，关闭自动移交；此时 `timeout` 保留原生硬超时语义，`hard_timeout` 优先。
- 如运行于 Pi Web，扩展可选注册其现有 session-liveness 协议，在有活动任务时避免自动闲置回收。显式关闭或替换会话仍优先；普通 Pi 不依赖该协议。

## 开发与验证

统一开发优先在仓库根目录执行 `npm ci --include=dev --ignore-scripts --legacy-peer-deps` 和 `npm run check`，参见[根目录说明](../README.md#开发与验证)。单独开发本扩展时：

```bash
cd ~/pi-dev/pi-extensions-shuyuan/pi-background-bash
npm ci --ignore-scripts --legacy-peer-deps
npm run check
```

开发依赖锁定 Pi SDK 1.5.2，安装为 Pi 包时使用宿主提供的 SDK 和 TypeBox，不捆绑它们。

测试使用真实的 Pi Bash 后端及本地假模型：覆盖原生前台结果、主动/自动/手动后台、软/硬超时、取消隔离、输出截断、日志上限、会话隔离与清理，以及真实 AgentSession 中直接调用和 codemode 嵌套调用后的完成唤醒。SDK 集成测试禁止所有网络请求，不调用外部模型、不产生模型费用。

除了原生和 SDK 测试，Web 解析、协议、桥接和资源白名单也纳入 `npm run check`。对真实 fork 的浏览器验证：

```bash
PI_WEB_PROJECT=/data/repos/pi-web/hkk/pi-web-ext \
PI_WEB_E2E_PORT=30145 npm run test:web
```

该测试打包并安装 tarball，创建隔离的 agent 目录，启动一个离线假模型的 Turbopack 服务；不修改真实的 Pi 配置。目标 checkout 不能已有 dev 锁；端口被占用时测试拒绝运行，不停止既有服务。验证自动发现、下拉位置、收起后的运行计数、慢查询合并、前台排除、外部点击/Esc、当前输出、确认式停止、前台移交、会话隔离、窄屏、资源更新、仅禁用 Web 和缺失目标，截图及日志保存在输出的系统临时目录。

已在 Linux / Pi SDK 1.5.2 验证；类型检查及 53 个单元/SDK/桥接相关测试通过。通知修复的真实 SDK 回归覆盖自然结束、完成后 Stop、清队后完成、Stop 后完成，并确认 JSONL 中只保存一次事实、没有伪造用户消息或意外模型请求。Web 布局此前通过真实 fork 的 Chromium 桌面和手机尺寸验证；本次没有更改 Web 界面或重启正在使用的宿主，未重新运行浏览器 E2E。尚未在真实 Safari/iOS、macOS 或 Windows 设备认证。

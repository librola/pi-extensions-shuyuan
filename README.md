# pi-extensions-shuyuan

统一管理两个 Pi 扩展的 monorepo，使用 npm workspaces 安装开发依赖、执行检查。两个扩展保留独立目录和包清单，运行行为不变。

| 扩展 | 功能 | 说明 |
| --- | --- | --- |
| `pi-error-retry` | 按规则重试模型错误，输出长度截断后自动续写 | [文档](pi-error-retry/README.md) |
| `pi-background-bash` | 受管后台 Bash、完成唤醒、任务查询及 Pi Web 顶部任务下拉框 | [文档](pi-background-bash/README.md) |

## 安装

从 GitHub 一次安装两个扩展：

```bash
pi install git:github.com/librola/pi-extensions-shuyuan
```

或安装本地仓库：

```bash
pi install ~/pi-dev/pi-extensions-shuyuan
```

以上命令会修改 Pi 的包配置；现有会话需执行 `/reload`，或新开会话。不要同时加载原来单独安装的同名扩展，避免重复注册和恢复逻辑竞争。本仓库不会自动修改已有 Pi 配置。

仓库根清单声明两个原生入口，并复用 `pi-background-bash` 的 Web 资源。支持 `piWeb` API v1 的扩展版 Pi Web 可从持久 Pi 包声明自动发现顶部任务下拉框；CLI 不加载浏览器代码。Web 公共协议、包身份和兼容版本保持不变。

仅需一个扩展时，也可安装其本地子目录：

```bash
pi install ~/pi-dev/pi-extensions-shuyuan/pi-error-retry
pi install ~/pi-dev/pi-extensions-shuyuan/pi-background-bash
```

不修改配置的临时 CLI 试用：

```bash
pi -e ./pi-error-retry/index.ts -e ./pi-background-bash/src/index.ts
```

**注意：错误规则命中后会无限重试，可能持续产生请求和费用；请按需配置规则并及时停止永久性错误。后台任务不跨进程重启或原生 reload 保留。** 详细边界见各扩展文档。

## 开发与验证

需要 Node.js >= 22.19.0。从仓库根目录执行：

```bash
npm ci --include=dev --ignore-scripts --legacy-peer-deps
npm run check
```

根 `package-lock.json` 管理 workspace 依赖；子目录保留原锁文件供独立开发使用。Pi SDK 和 TypeBox 是宿主提供的 peer 依赖，不作为扩展运行时依赖捆绑。根检查包含两个扩展的类型检查、单元/SDK/桥接测试，以及统一安装入口、Web 资源路径和 tarball 内容测试；模型调用均使用本地假 provider。

也可单独执行：

```bash
npm test
npm run check --workspace=pi-error-retry
npm test --workspace=pi-error-retry
npm run check --workspace=pi-background-bash
```

真实扩展版 Pi Web 的浏览器端到端测试需要独立且空闲的 fork checkout：

```bash
PI_WEB_PROJECT=/path/to/pi-web-ext \
PI_WEB_E2E_PORT=30145 npm run test:web
```

该测试使用隔离 agent 配置和离线假模型，不修改真实 Pi 配置、不重启已有服务。详见[后台 Bash 开发说明](pi-background-bash/README.md#开发与验证)。

## 目录

```text
pi-extensions-shuyuan/
├── package.json            # workspace、统一 Pi 与 Web 入口
├── package-lock.json       # workspace 开发依赖锁
├── pi-error-retry/         # 错误恢复扩展及其测试
├── pi-background-bash/     # 后台 Bash、Web 资源及其测试
└── tests/                  # 统一包的安装与资源回归测试
```

原目录的 Git 元数据、node_modules 和临时产物不纳入本仓库；原目录仍保留，后续统一在本仓库开发。

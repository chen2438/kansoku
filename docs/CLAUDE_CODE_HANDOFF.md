# Kansoku 交接给 Claude Code 的维护说明

更新时间：2026-07-12  
仓库：`/Users/nanmener/Github/kansoku`  
交接时分支：`feature/binance-perp-v2`  
交接时提交：`11445f99 feat: add Binance top volume batch analysis`

> 分支和提交号只是交接时快照。接手后先执行 `git status --short`、`git branch --show-current` 和 `git log -5 --oneline`，不要假定本文里的提交号一直是最新状态。

## 一句话说明

Kansoku 是个人美股交易研究工作台，不是面向公众的软件产品。它同时包含研究记录、自定义市场分析 Skill，以及一个支持 Web 和 Electron 的本地图表应用。研究结论最终必须落到 `journal/`、`stocks/` 或图表 JSON，SQLite 只保存应用运行流水，不能取代研究档案。

## 接手后的第一轮检查

```bash
cd /Users/nanmener/Github/kansoku
git status --short
git branch --show-current
git log -5 --oneline

source ~/.nvm/nvm.sh
nvm use 22
node --version
pnpm --version
```

要求使用 Node.js 22。项目锁定 `pnpm@11.10.0`。如果 Corepack 自动改写 `package.json`，运行命令时加：

```bash
COREPACK_ENABLE_AUTO_PIN=0
```

先完整阅读仓库根目录的 `CLAUDE.md`。它是 Claude Code 的主要项目规则。修改某个子目录前，再检查该目录附近是否有更具体的说明文件。

## 不能破坏的项目规则

1. 仓库内文档和对话说明使用中文白话。Ticker、API、CLI 和文件路径保留英文。
2. 这是美股项目。市场范围工作不要查询港股、A 股或新加坡股票。
3. 需要持仓、成本、盈亏或账户余额时，直接查长桥，不要先问用户。
4. `journal/`、`stocks/` 和 `journal/charts/data/*.json` 是研究记录的主要持久化层。
5. 工作流执行完必须落档。不要只在对话里给结论。
6. `stocks/{SYMBOL}.md` 只能增量更新，不要整份重写。
7. 数字必须能追溯到原始来源。公司公告、SEC 文件和真实行情优先；社区帖和截断标题只能当线索。
8. 财报数字要区分 GAAP 与 non-GAAP，同时看同比和环比。
9. 用户给出“突破、冲高、回调”等方向判断时，要重新拉实时行情核对，不能直接附和。
10. 前瞻判断使用 Bull/Base/Bear 三种情景，概率相加等于 100%，并写清触发条件。
11. 工作区可能有用户自己的未提交改动。编辑前先看 `git status` 和差异，不要覆盖、清理或回退不属于当前任务的内容。

## 仓库结构

```text
.
├── CLAUDE.md                         # Claude Code 的项目规则，优先阅读
├── RUN.md                            # 常用启动与停止命令
├── README.md                         # 项目总体说明
├── .claude/skills/                   # 项目自研 Skill
├── .agents/skills/                   # 第三方 Skill，由锁文件还原
├── journal/                          # 每日研究记录
├── stocks/                           # 个股研究笔记
├── docs/                             # 设计、发布与维护文档
└── app/                              # pnpm workspace
    ├── packages/core/                # 共享业务逻辑、数据源、AI、类型契约
    ├── server/                       # Hono/Tsuki 内核与 Node 宿主
    ├── web/                          # Vite + React 前端
    ├── desktop/                      # Electron 壳、IPC、原生桥与打包
    └── shared/                       # 跨包数据类型和工具
```

应用遵循“共享核心 + 两种传输”的结构：

- Web：前端通过 HTTP/WebSocket 调用 `server`。
- Electron：前端通过 IPC/MessagePort 调用桌面宿主。
- 核心业务逻辑尽量放在 `app/packages/core/`，不要在 HTTP 控制器和 Electron IPC 中各写一套。
- 对外接口先改 `app/packages/core/src/contract/` 的类型契约，再接服务、HTTP、IPC 和前端。

## 常用启动命令

每个新终端先切 Node 22：

```bash
source ~/.nvm/nvm.sh
nvm use 22
cd /Users/nanmener/Github/kansoku
```

Web 开发模式：

```bash
COREPACK_ENABLE_AUTO_PIN=0 pnpm --dir app dev
```

Electron 开发模式：

```bash
COREPACK_ENABLE_AUTO_PIN=0 pnpm --dir app dev:desktop
```

生产式 Web 启动请以 `RUN.md` 和 `app/README.md` 为准。默认页面端口是 `5199`，Web 开发态的内核端口默认是 `5200`。

## 测试和类型检查

```bash
cd /Users/nanmener/Github/kansoku/app
pnpm test
pnpm typecheck
```

交接前最近一次全量测试结果：

- 125 个测试文件全部通过。
- 1,159 项测试全部通过。
- `packages/core`：594 项。
- `server`：198 项。
- `desktop`：211 项。
- `web`：156 项。

这只是 2026-07-12 的基线。以后要以当前分支实际运行结果为准。

只跑单个包或测试文件：

```bash
pnpm --filter @trade/core test
pnpm --filter @trade/server test
pnpm --filter @trade/desktop test
pnpm --filter @trade/web test

cd packages/core
pnpm exec vitest run test/binance.test.ts test/binanceBatch.test.ts
```

## 重要环境坑：better-sqlite3 在 Node 与 Electron 之间切换

`app` 的多个 workspace 共用同一份 `better-sqlite3` 原生文件，但普通 Node 和 Electron 43 需要不同的原生接口版本。因此：

- 运行 `pnpm test`、`server` 时，需要 Node 版本。
- 运行 `pnpm --dir app dev:desktop` 时，需要 Electron 版本。
- `server/scripts/ensureNativeAbi.mjs` 和 `packages/core/scripts/ensureNativeAbi.mjs` 会自动恢复 Node 版本。
- `desktop/scripts/ensureDevNative.mjs` 会自动用 `electron-rebuild` 恢复 Electron 版本。

不要让 Electron 运行着再切换成 Node 版本。macOS 可能直接用 `SIGKILL` 终止加载了错误原生文件的 Node 进程，表现为退出码 137，而不是普通的模块版本错误。

推荐顺序：

```bash
# 跑测试前，先完全关闭 Electron 开发进程或桌面 App
cd /Users/nanmener/Github/kansoku/app
pnpm --filter @trade/core pretest
pnpm test

# 再启动桌面开发环境；首次切换通常会重建约几十秒
cd /Users/nanmener/Github/kansoku
COREPACK_ENABLE_AUTO_PIN=0 pnpm --dir app dev:desktop
```

看到下面日志时不要急着按 `Ctrl+C`：

```text
[ensureDevNative] better-sqlite3 is not built for Electron — rebuilding
Building modules: better-sqlite3
```

等到出现 `✔ Rebuild Complete`。重建期间桌面内核还没启动，Vite 可能暂时报 `ws proxy error: ECONNREFUSED`，这是预期现象。

如果测试再次出现 `SIGKILL`：

```bash
lsof app/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

先关闭输出中的 Electron 进程，再按上面的顺序恢复 Node 版本。不要把 `kill -9` 当成默认方案。

## 当前分支的 Binance 改动

当前分支最近的主要提交是：

```text
11445f99 feat: add Binance top volume batch analysis
```

这批改动新增首页“一键 AI 分析 Binance Top 20”：

- 根据 Binance 24 小时 USDT 成交额选择正在交易的永续合约前 20 名。
- 使用 2 路并发运行 Analyst。
- 显示等待、运行、完成和失败状态。
- 只有真正生成新图表才算完成。
- 批次状态只存在当前进程内，服务重启后清空。
- Web HTTP 和 Electron IPC 共用同一套核心服务。

主要文件：

```text
app/packages/core/src/ai/binanceBatch.ts
app/packages/core/src/services/marketdata/binance.ts
app/packages/core/src/contract/symbols.ts
app/packages/core/src/modules/symbols/symbols.service.ts
app/server/src/modules/symbols/symbols.controller.ts
app/desktop/src/ipc/symbolsIpc.ts
app/web/src/pages/home/BinanceTopAnalysis.tsx
docs/BINANCE_INTEGRATION.md
```

对应测试：

```text
app/packages/core/test/binance.test.ts
app/packages/core/test/binanceBatch.test.ts
app/server/test/analyst-route.test.ts
```

Binance 公共行情不需要 API Key。项目目前只读取行情，不读取 Binance 账户，也不下单。完整边界和已知限制见 `docs/BINANCE_INTEGRATION.md`。

## 数据和凭证

- 根目录 `.env` 会被忽略，不能提交。
- FRED 和 SEC 等脚本凭证由自研 Skill 的共享环境模块读取。
- AI 模型与 API Key 主要在应用 `/settings` 页面配置，保存进本地 SQLite；不要把密钥写进源码或文档。
- `journal/charts/data/app.db` 保存点评、AI 用量、图表索引和已结束预测的缓存。
- 图表正文仍是 `journal/charts/data/*.json`。
- Electron 安装版有自己的应用数据目录；从仓库导入只复制图表 JSON，不复制正在使用的 SQLite。

## Skill 和研究工作流

路由原则：

- 第一次全面了解单只股票：`stock-deep-dive`。
- 看当天资金从哪些板块流向哪些板块：`capital-rotation`。
- 盘中持续跟踪一组标的：`market-session-tracker`。
- 只查一个维度：直接使用对应数据 Skill，不要启动完整工作流。

自研 Python 脚本从仓库根目录运行，支持统一参数：

```bash
python3 .claude/skills/<source>/scripts/<cmd>.py --help
python3 .claude/skills/<source>/scripts/<cmd>.py --smoke
```

成功输出统一为 `{"ok": true, "data": ..., "meta": ...}`；失败输出 `{"ok": false, "error": ..., "hint": ...}` 并使用非零退出码。

## Git 和修改习惯

开始任务：

```bash
git status --short
git diff --stat
git diff
```

结束任务至少执行：

```bash
git diff --check
pnpm --dir app test
pnpm --dir app typecheck
git status --short
```

测试可能因为真实外部服务、凭证或市场时段受限。遇到这种情况要明确区分“代码测试失败”和“环境无法执行”，不要把未运行说成已通过。

不要使用 `git reset --hard`、`git checkout -- <file>` 或批量删除来清理工作区，除非用户明确要求。提交前只暂存本次任务涉及的文件，并再次检查暂存差异。

## 发布相关

Electron 发布流程、Sparkle 更新和密钥管理见：

- `docs/desktop-release.md`
- `docs/desktop-release-notes-template.md`
- `app/desktop/README.md`

发布密钥代表发布权限。没有用户明确授权，不要 push、打 tag、创建 GitHub Release、修改发布密钥或触发正式发布。

## Claude Code 的工作原则

1. 先读规则和现状，再动代码。
2. 优先复用 `core` 业务逻辑，保持 HTTP 与 Electron 行为一致。
3. 接口改动要同步契约、服务、两种传输、前端和测试。
4. 外部行情和财务数字要核对来源与时间戳。
5. 改动后运行与风险相称的测试；能跑全量时跑全量。
6. 报告结果时给出真实命令、通过数量、失败原因和工作区状态。
7. 不确定的信息先从仓库和运行结果里查，不要猜。

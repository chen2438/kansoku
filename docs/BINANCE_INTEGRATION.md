# Binance Market Data Integration

本文档记录 Kansoku 的 Binance 行情扩展。后续与 Binance、加密永续、TradFi 永续及相关 AI 分析有关的改动，应同步更新本文档，并在文末追加更新日志。

## 目标

- 在保留 Longbridge 美股数据源的同时，支持 Binance USD-M 永续合约。
- 支持 BTC、ETH 等加密永续，以及股票、ETF、贵金属等 TradFi 永续。
- 复用现有图表、AI analyst、commentator、SQLite 归档与自动监控流程。
- 尽量将实现集中在独立 provider 中，降低同步原作者更新时的冲突概率。
- 第一阶段仅使用公共行情，不读取 Binance 账户，也不执行交易。

## Symbol 规则

项目根据 symbol 自动选择行情提供者：

| Symbol 示例 | Provider | 分类 |
| --- | --- | --- |
| `NVDA.US` | Longbridge | 美股 |
| `BTCUSDT` | Binance USD-M | 加密永续 |
| `ETHUSDT` | Binance USD-M | 加密永续 |
| `NVDAUSDT` | Binance USD-M | TradFi 股票永续 |
| `MUUSDT` | Binance USD-M | TradFi 股票永续 |
| `XAUUSDT` | Binance USD-M | TradFi 商品永续，黄金 |
| `XAGUSDT` | Binance USD-M | TradFi 商品永续，白银 |

不含 `.` 且匹配 `^[A-Z0-9]+USDT$` 的 symbol 会路由到 Binance。Binance `exchangeInfo` 负责最终确认合约是否存在及当前是否可交易。

Binance 合约类型主要包括：

- `PERPETUAL`：BTC、ETH 等普通加密永续。
- `TRADIFI_PERPETUAL`：股票、ETF、商品等传统资产价格挂钩永续。

## 已接入行情

Binance provider 当前接入以下公共数据：

- 合约元数据与交易状态
- 最新成交价与 24 小时涨跌
- 1m 至 1M K 线
- 标记价格与指数价格
- 当前资金费率、下次结算时间及资金费率历史
- 当前未平仓量及 5 分钟 OI 历史
- 全市场多空账户比
- 大户多空账户比
- 大户多空持仓比
- 主动买入/卖出量比
- 20 档盘口深度
- 最近 50 笔聚合成交
- 实时强平快照流

这些数据均来自 Binance 公共 REST/WebSocket 接口，无需 `BINANCE_API_KEY`。

## 强平数据说明

Binance 没有在本实现中使用公开的完整历史强平 REST 数据。服务端首次请求衍生品快照时会启动 `!forceOrder@arr` WebSocket，并在内存中缓存每个 symbol 最近 100 条强平事件。

因此：

- 强平数据只覆盖本次服务启动并连接 WebSocket 之后的时间。
- `liquidationCoverageStartedAt` 表示覆盖起点。
- 服务重启后缓存清空。
- Binance 推送本身是快照，不应视为完整逐笔强平数据库。
- AI prompt 已要求模型不得把该字段解释成完整历史。

## AI 分析

`ReassessPack` 新增 `derivatives` 字段。Binance 合约分析会向 analyst 提供：

- 合约分类和底层资产类型
- 标记价与指数价偏离
- 资金费率和历史
- OI 当前值及变化
- 多空账户/持仓结构
- 主动买卖量
- 盘口、近期成交和已捕获强平

Binance symbol 的市场参照使用 `BTCUSDT` 和 `ETHUSDT`。现有 `market.spy`、`market.qqq` 字段暂时承载这两个参照，AI prompt 已明确说明这一兼容行为。

股票和商品 TradFi 永续虽然可以 24/7 交易，但底层传统市场存在休市。AI 已被要求关注：

- 传统市场休市时的指数价更新机制
- 合约相对外部参考价格的溢价或贴水
- 低流动性时段风险
- 周末、节假日及传统市场重新开盘时的跳空风险

目前 Binance provider 不提供新闻。TradFi 永续的公司新闻、财报和宏观数据仍需后续增加跨 provider 映射。

## 自动监控

已有 intraday 分析且持有有效页面租约的 Binance symbol 会进入 AI scheduler：

- 美股继续遵守原项目的盘前、日盘、盘后调度。
- Binance 合约在美股休市、夜间和周末仍会进入 24x7 巡检。
- commentator 继续检查价格、MACD、关键位和心跳触发。
- commentator 判断需要升级时，继续调用 analyst 重新分析。
- 自动监控不会自动下单，也不会自动扫描全部 Binance 合约。

## 前端使用

在首页代码输入框直接输入：

```text
BTCUSDT
ETHUSDT
NVDAUSDT
MUUSDT
XAUUSDT
XAGUSDT
```

输入不会被追加 `.US`。首次进入没有历史分析的标的时，点击“AI 生成分析”。生成后，Cockpit 的原资金流区域会针对 Binance symbol 显示合约行情，包括标记价、指数价、溢价、资金费率、OI、多空比、主动买卖比、买一卖一和强平覆盖状态。

独立行情接口：

```text
GET /api/symbols/BTCUSDT/derivatives
GET /api/symbols/NVDAUSDT/derivatives
GET /api/symbols/XAUUSDT/derivatives
```

## 配置

默认无需新增 `.env` 配置。需要切换 Binance API 地址时可设置：

```dotenv
BINANCE_FUTURES_REST_URL=https://fapi.binance.com
BINANCE_FUTURES_WS_URL=wss://fstream.binance.com/ws
```

这些变量主要用于代理、测试网或兼容网关。当前实现仅支持 Binance USD-M API 形状。

## 验证

快速验证公共行情：

```bash
cd app
COREPACK_ENABLE_AUTO_PIN=0 pnpm --filter @trade/server exec vite-node scripts/verify-binance.ts
```

指定 symbol：

```bash
COREPACK_ENABLE_AUTO_PIN=0 pnpm --filter @trade/server exec vite-node scripts/verify-binance.ts BTCUSDT MUUSDT XAGUSDT
```

完整检查：

```bash
COREPACK_ENABLE_AUTO_PIN=0 pnpm test
COREPACK_ENABLE_AUTO_PIN=0 pnpm typecheck
```

首次实现验证结果：服务端 739 项测试、前端 7 项测试全部通过，前后端 TypeScript 检查通过。真实 API 已验证 `BTCUSDT`、`NVDAUSDT` 和 `XAUUSDT`。

## 主要文件

- `app/server/src/services/marketdata/binance.ts`：Binance REST provider。
- `app/server/src/services/marketdata/binanceLiquidations.ts`：强平 WebSocket 与内存缓存。
- `app/server/src/services/marketdata/registry.ts`：按 symbol 路由 provider。
- `app/server/src/ai/datapack.ts`：衍生品数据进入 AI 快照。
- `app/server/src/ai/analyst.ts`：永续合约分析纪律。
- `app/server/src/ai/scheduler.ts`：Binance 24x7 自动监控。
- `app/server/src/routes/symbols.ts`：symbol 标准化与 derivatives API。
- `app/web/src/pages/home/QuickBar.tsx`：Binance symbol 输入入口。
- `app/web/src/pages/cockpit/FlowTab.tsx`：合约行情展示。
- `app/server/scripts/verify-binance.ts`：真实 API 验证脚本。
- `app/server/test/binance.test.ts`：provider 单元测试。

## 与上游同步

开发分支为 `feature/binance-perp`，原作者仓库为 `upstream`，个人 Fork 为 `origin`。同步原作者更新：

```bash
git switch main
git fetch upstream
git merge --ff-only upstream/main
git push origin main

git switch feature/binance-perp
git rebase main
```

发生冲突时优先保留独立 Binance provider。最可能冲突的共享入口包括：

- `marketdata/registry.ts`
- `ai/datapack.ts`
- `ai/analyst.ts`
- `ai/scheduler.ts`
- `routes/symbols.ts`
- `FlowTab.tsx`
- `QuickBar.tsx`

解决 rebase 冲突并通过测试后：

```bash
git push --force-with-lease origin feature/binance-perp
```

## 已知限制与后续方向

- 暂未接入 Binance 账户、持仓、订单或交易。
- 暂未接入 COIN-M、现货和 Binance Options。
- 暂未持久化强平历史。
- OI、多空比等部分接口对新上市或 TradFi 合约可能返回空值；provider 会降级为 `null`。
- TradFi 新闻、财报、FRED 宏观映射尚未自动注入。
- 相对成交量和日内关键位仍部分沿用美股逻辑，需要继续改造成真正的 24x7 UTC/session 模型。
- Binance 图表实时更新当前使用 REST 轮询回退；K 线 WebSocket 可作为后续优化。
- 尚未接入 OKX，也尚未实现跨交易所价差、资金费率和 OI 对比。

## 更新日志

### 2026-07-11

- 新增 Binance USD-M provider。
- 支持普通加密永续和 `TRADIFI_PERPETUAL`。
- 接入 K 线、价格、标记价、指数价、资金费率、OI、多空比、主动买卖、盘口、聚合成交和强平流。
- 接入 AI DataPack 和 analyst prompt。
- 增加 Binance 24x7 自动监控。
- 增加首页 symbol 输入、Cockpit 合约行情面板和 derivatives API。
- 增加验证脚本与单元测试。
- 调整实时图表推送热路径，外部事件/期权刷新继续由轮询负责。
- 将图表 HTTP 请求的最大 K 线 count 限制为 1000。
- 新增 `GET /api/symbols/:sym/validate` 标的验证接口。
- 首页代码输入框改为验证成功后才跳转，无效代码就地显示错误。
- 无历史分析页面增加 Longbridge/Binance 数据源及市场分类展示。

后续更新格式：

```markdown
### YYYY-MM-DD

- 描述新增、修改或修复内容。
- 如有兼容性变化，注明迁移方式。
- 如有新增限制或待办，同步更新“已知限制与后续方向”。
```

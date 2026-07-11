# Binance Market Data Integration

本文档记录 Kansoku 的 Binance USD-M 扩展。后续 Binance、OKX、永续合约及相关 AI 改动应同步更新本文档与更新日志。

## 架构

当前实现基于上游 `@trade/core + typed contract + HTTP/IPC` 架构：

- Provider：`app/packages/core/src/services/marketdata/binance.ts`
- 强平流：`binanceLiquidations.ts`
- Provider 路由：`marketdata/registry.ts`
- 业务服务：`modules/symbols/symbols.service.ts`
- Typed contract：`contract/symbols.ts`
- Web HTTP：Tsuki `SymbolsController`
- Electron：`SymbolsIpc`
- 前端：统一调用 `client.symbols.*`

因此 Web 和 Electron 共享同一份 Binance 业务逻辑。

## 支持范围

- 普通加密永续：`BTCUSDT`、`ETHUSDT` 等 `PERPETUAL`
- 股票/ETF TradFi 永续：`NVDAUSDT`、`MUUSDT`、`SPYUSDT` 等
- 商品 TradFi 永续：`XAUUSDT`、`XAGUSDT` 等

匹配 `^[A-Z0-9]+USDT$` 的代码由 Binance provider 处理，并使用 `exchangeInfo` 验证是否存在及是否处于 `TRADING`。

## 行情

- 最新价与 24h 涨跌
- K 线
- 标记价、指数价与资金费率
- 资金费率历史
- 当前与历史 OI
- 全市场与大户多空比
- 主动买卖比
- 20 档盘口
- 最近聚合成交
- 服务启动后捕获的强平快照

公共行情不需要 Binance API Key。强平只覆盖 `liquidationCoverageStartedAt` 之后，服务重启会清空内存缓存。

## API

```text
GET /api/symbols/BTCUSDT/validate
GET /api/symbols/BTCUSDT/derivatives
```

Electron 使用等价的 `symbols.validate` 与 `symbols.derivatives` IPC。

## AI 与监控

`ReassessPack.derivatives` 向 analyst 提供资金费率、OI、多空结构、盘口、成交和强平。Binance 的市场参照使用 BTCUSDT/ETHUSDT。已有分析且租约有效的 Binance 标的会在美股休市、夜间和周末继续接受 scheduler 巡检。

## 配置与验证

可选配置：

```dotenv
BINANCE_FUTURES_REST_URL=https://fapi.binance.com
BINANCE_FUTURES_WS_URL=wss://fstream.binance.com/ws
```

验证：

```bash
cd app
pnpm --filter @trade/server exec vite-node scripts/verify-binance.ts
pnpm test
pnpm typecheck
```

## 已知限制

- 不读取 Binance 账户，不下单。
- 暂未接入 COIN-M、现货、Options 与 OKX。
- 强平历史未持久化。
- TradFi 新闻、财报和 FRED 宏观数据尚未自动映射。
- Binance K 线目前以 REST 轮询作为实时回退，尚未接入专用 K 线 WebSocket。
- 日内关键位和相对成交量仍有部分美股 session 假设。

## 更新日志

### 2026-07-11

- 基于上游新 `@trade/core` 架构重新迁移 Binance USD-M provider。
- 新增 typed `validate`、`derivatives` contract，同时覆盖 HTTP 与 Electron IPC。
- 恢复 AI derivatives DataPack、24x7 scheduler、前端验证和合约行情面板。
- 修复混合盘面复盘错误地统一使用 Longbridge provider，导致 Binance 合约缺少涨跌和无法判定的问题。
- 修复带 `analysis` 查询参数的标的页面把查询串拼入 symbol，导致手动重新分析失败的问题。
- 修复 Electron 打包 `pi-ai` 后 OAuth 动态模块路径失效，导致 Codex 分析零调用退出的问题；同时透传底层 Agent provider 错误。
- 安装 Node 22，以满足上游 pnpm 11 要求。

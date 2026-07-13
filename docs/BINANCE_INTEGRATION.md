# Binance 集成

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

账号与测试网订单共用另一组业务入口：

- 账号与下单底层：`app/packages/core/src/services/marketdata/binanceAccount.ts`
- 账号业务服务：`modules/binanceAccount/binanceAccount.service.ts`
- Typed contract：`contract/binanceAccount.ts`
- 前端设置页：`app/web/src/pages/settings/BinanceAccountCard.tsx`

测试网手动下单同样同时覆盖 Web HTTP 和 Electron IPC。

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

账号接口：

```text
GET  /api/binanceAccount/status
GET  /api/binanceAccount/balance
GET  /api/binanceAccount/positions
GET  /api/binanceAccount/open-orders
POST /api/binanceAccount/testnet/orders
POST /api/binanceAccount/testnet/positions/close
POST /api/binanceAccount/testnet/orders/cancel
```

三个写接口只接受人工确认后的测试网开仓、整仓市价平仓或撤单。开仓参数包括方向、初始保证金、杠杆倍数，以及可选的止盈价和止损价。服务端会再次检查当前凭证必须属于测试网；主网开仓和平仓不会仅靠页面隐藏，而是直接返回拒绝。

测试网开仓固定使用市价单。服务端先读取标记价格和该合约的数量规则，再按“初始保证金 × 杠杆倍数 ÷ 标记价格”计算数量并向下取整。开仓成交后，可继续提交按标记价格触发、平掉整个仓位的止盈单和止损单。如果开仓已成功但保护单失败，接口会保留开仓结果并逐项返回失败原因，页面会用警告提示用户立即处理。

设置页的开仓确认使用默认不勾选的复选框，不再要求输入文字。持仓列表提供“市价平仓”按钮；用户点击并确认后，服务端会重新读取当前实时持仓数量，而不是使用页面缓存的数量。单向持仓会带 `reduceOnly=true`，多空双向模式则指定对应的 `positionSide`，避免误开反向仓位。

## AI 与监控

`ReassessPack.derivatives` 向 analyst 提供资金费率、OI、多空结构、盘口、成交和强平。Binance 的市场参照使用 BTCUSDT/ETHUSDT。已有分析且租约有效的 Binance 标的会在美股休市、夜间和周末继续接受 scheduler 巡检。

首页的 `AI 分析 Binance Top 20` 会按 Binance 24 小时 USDT 成交额实时选取交易中的永续合约，并以 2 路并发运行 Analyst。批次状态仅保存在当前进程内，服务重启后清空；每项只有实际生成新图表才算完成。

其下方的 `AI 分析 Binance Top 20 并下单` 只允许在已连接 Binance 期货测试网时启动，并需要用户先核对一次风险确认弹窗。每个标的生成新分析后立即处理，不检查入场是否已经触发：做多或做空会以 20 USDT 初始保证金、10 倍杠杆市价开仓，AI 止损价作为止损，目标1作为止盈；观望不下单。方向明确但缺少有效止损价或目标1时跳过下单并显示失败原因。每项分别记录分析状态、下单状态、开仓订单号和保护单错误。

自动批次遵守“一个标的只允许一个活动仓位”的保守规则。每次开仓前，服务端重新查询该标的的实时持仓、普通挂单和条件单；任一存在就跳过，不加仓、不平仓、不反手。该规则只作用于首页自动批次，设置页人工开仓不受影响。自动订单带本批次稳定的客户端订单编号，方便识别重复请求和后续排查；程序不会自动撤销用户手动创建的订单。

下单失败会集中显示在批次列表下方。Binance 错误 `-4411` 表示当前账号尚未签署 TradFi Perps 协议，常见于 XAUUSDT、XAGUSDT 及股票/ETF 永续；程序不会代替用户接受账户协议，必须由用户本人登录对应的 Binance Futures 测试网账户，在 TradFi 或具体合约交易页按页面提示阅读并接受后重试。如果测试网页面没有入口，该测试网账号暂时不能交易这类合约。

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

- Binance 账号支持读取余额、持仓和普通挂单；开仓只支持测试网人工确认的市价开仓。
- 主网下单仍被服务端硬性禁止；只有用户明确点击并确认首页的批量分析下单按钮，AI 分析才会触发测试网订单。
- 暂不支持测试网改单，也没有在挂单列表中统一展示或撤销条件止盈、止损单。
- “初始保证金”用于按当前标记价格估算开仓数量；实际占用金额会因市价成交价格、数量取整和 Binance 风险规则产生小幅差异。
- 暂未接入 COIN-M、现货、Options 与 OKX。
- 强平历史未持久化。
- TradFi 新闻、财报和 FRED 宏观数据尚未自动映射。
- Binance K 线目前以 REST 轮询作为实时回退，尚未接入专用 K 线 WebSocket。
- 日内关键位和相对成交量仍有部分美股 session 假设。

## 更新日志

### 2026-07-13

- 首页新增 `AI 分析 Binance Top 20 并下单`，分析完成一项就立即按固定 20 USDT 保证金、10 倍杠杆在测试网执行；做多/做空使用市价开仓、AI 止损价和目标1，观望跳过。
- 批量下单在服务端检查测试网连接和一次性人工确认，主网继续硬性禁止；首页逐项显示已下单、观望跳过、下单失败和订单号。
- 首页在批次列表下方集中显示下单失败日志；`-4411` 会翻译为 TradFi Perps 协议未签署，并给出人工开通提示。
- 自动批次下单前检查实时持仓、普通挂单和条件单；已有任一状态就跳过，页面单独统计“已有仓位/挂单跳过”。
- 自动开仓单及其止盈止损使用同一批次派生的客户端订单编号，便于识别重复请求；不自动管理用户手动订单。
- 设置页取消“完全不下单”的限制，新增测试网手动确认下单。
- 测试网开仓表单新增开多/开空、初始保证金、1–125 倍杠杆、可选止盈价和止损价。
- 开仓固定使用市价单；服务端自动读取标记价格与数量步进规则，计算并向下取整实际合约数量。
- 开仓成功后通过 Binance 条件单接口提交止盈和止损；保护单失败时明确保留并返回已成交的开仓结果。
- 开仓确认由输入“确认”改为勾选“我已核对以上参数”。
- 测试网持仓列表新增整仓市价平仓；后端提交前重新读取持仓数量，并继续硬性禁止主网平仓。
- 测试网挂单列表提供人工确认撤单。
- 后端同时校验手动确认标记和测试网凭证，继续硬性禁止主网下单。
- 账号密钥继续使用本机加密存储；测试网 key 需要开启期货交易权限。

### 2026-07-11

- 基于上游新 `@trade/core` 架构重新迁移 Binance USD-M provider。
- 新增 typed `validate`、`derivatives` contract，同时覆盖 HTTP 与 Electron IPC。
- 恢复 AI derivatives DataPack、24x7 scheduler、前端验证和合约行情面板。
- 修复混合盘面复盘错误地统一使用 Longbridge provider，导致 Binance 合约缺少涨跌和无法判定的问题。
- 修复带 `analysis` 查询参数的标的页面把查询串拼入 symbol，导致手动重新分析失败的问题。
- 修复 Electron 打包 `pi-ai` 后 OAuth 动态模块路径失效，导致 Codex 分析零调用退出的问题；同时透传底层 Agent provider 错误。
- 新增一键批量分析 Binance USDT 永续 24 小时成交额 Top 20，提供逐标的进度与失败状态。
- 安装 Node 22，以满足上游 pnpm 11 要求。

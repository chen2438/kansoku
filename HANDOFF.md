# Kansoku Handoff

Updated: 2026-07-12 (Europe/London)

## Repository State

- Workspace: `/Users/nanmener/Github/kansoku`
- Current branch: `feature/binance-perp-v2`
- Fork: `origin = https://github.com/chen2438/kansoku.git`
- Author repository: `upstream = https://github.com/Innei/kansoku.git`
- Upstream push is intentionally disabled.
- Current HEAD: `9a6f5e5c fix(desktop): preserve Codex OAuth runtime modules`
- Branch is one commit ahead of `origin/feature/binance-perp-v2`.
- `9a6f5e5c` has not been pushed yet.
- `origin/main` and `upstream/main` are at `0c4a48fa`.
- Local `main` still points to `3e21e826`; do not use it as the upstream baseline. Rebase feature work against `upstream/main`.
- At handoff, the only expected uncommitted file is this `HANDOFF.md`.

Recent feature commits:

```text
9a6f5e5c fix(desktop): preserve Codex OAuth runtime modules
7a289809 fix: route Binance recap and reassess correctly
1a4130f4 docs: update Binance integration for core architecture
9d291049 feat: migrate Binance data to core contracts
```

Recommended immediate Git action:

```bash
git add HANDOFF.md
git commit -m "docs: add project handoff"
git push origin feature/binance-perp-v2
```

## Runtime

Node.js 22 is required. Always initialize a new terminal with:

```bash
source ~/.nvm/nvm.sh
nvm use 22
```

The shell environment currently contains `ELECTRON_RUN_AS_NODE=1`. It must be removed when launching Electron.

Reliable Web launch:

```bash
cd /Users/nanmener/Github/kansoku
COREPACK_ENABLE_AUTO_PIN=0 pnpm start
```

Reliable Electron launch after the desktop build exists:

```bash
cd /Users/nanmener/Github/kansoku/app
env -u ELECTRON_RUN_AS_NODE COREPACK_ENABLE_AUTO_PIN=0 corepack pnpm --filter @trade/desktop start
```

Rebuild and launch Electron after source changes:

```bash
cd /Users/nanmener/Github/kansoku/app
COREPACK_ENABLE_AUTO_PIN=0 corepack pnpm --filter @trade/desktop build
env -u ELECTRON_RUN_AS_NODE COREPACK_ENABLE_AUTO_PIN=0 corepack pnpm --filter @trade/desktop start
```

Electron was running normally when this handoff was written. Web was stopped. A future conversation cannot rely on the old tool session ID, so inspect the process before starting another instance.

## Binance Integration

Detailed documentation and update log: `docs/BINANCE_INTEGRATION.md`.

Implemented:

- Binance USD-M provider for symbols matching `^[A-Z0-9]+USDT$`.
- Supports crypto perpetuals and Binance TradFi perpetuals such as stock/ETF and commodity contracts.
- Symbol validation through Binance `exchangeInfo` before navigation.
- Quotes, 24h change, klines, mark/index price, funding, OI, long/short ratios, taker ratios, order book, trades, and in-memory liquidation coverage.
- Typed Core contracts exposed through Web HTTP and Electron IPC.
- AI derivatives datapack and Binance-aware analyst prompt.
- Binance targets can be monitored 24/7 while an active comments-channel lease exists.
- Symbol page displays the selected data source.

Important files:

```text
app/packages/core/src/services/marketdata/binance.ts
app/packages/core/src/services/marketdata/binanceLiquidations.ts
app/packages/core/src/services/marketdata/registry.ts
app/packages/core/src/modules/symbols/symbols.service.ts
app/packages/core/src/contract/symbols.ts
app/packages/core/src/ai/datapack.ts
app/packages/core/src/ai/scheduler.ts
app/web/src/pages/SymbolCockpit.tsx
docs/BINANCE_INTEGRATION.md
```

Public Binance market data does not require an API key. The project currently supports USDT symbols only, not USDC-margined, COIN-M, spot, options, or OKX.

## Fixes Already Applied

1. Mixed recap provider routing
   - `overview.service.ts` now selects `getProvider(symbol)` per symbol.
   - Binance contracts now show 24h change and can be judged from Binance klines.
   - Mixed stock/futures regression test added to `overview-route.test.ts`.

2. Reassess route query parsing
   - `/symbol/ETHUSDT?analysis=...` previously passed the query string as part of the symbol.
   - `routePath()` now strips the query before PageRouter matching.

3. Electron Codex OAuth
   - Bundling `@earendil-works/pi-ai` relocated its runtime OAuth loader and broke relative dynamic imports.
   - Desktop now declares `pi-ai` as a direct dependency and excludes it from the main-process bundle.
   - `AgentSession.runTurn()` now rejects when the agent resolves with `state.errorMessage`, so provider failures are no longer misreported as "分析员未提交预测".

Electron OAuth was verified end to end after the quota reset:

- `LABUSDT` made two real Codex model calls.
- A new chart was written: `2026-07-11-labusdt-intraday-4`.
- The temporary auto-reassess diagnostic code was removed before the final build.

## AI Monitoring Behavior

- Scheduler tick: every 60 seconds.
- No-trigger heartbeat: every 5 minutes per active symbol.
- A symbol gets an active lease when its live `comments` channel is subscribed from a symbol page.
- Closing the page releases the lease after a 90-second grace period.
- Home/watchlist presence alone does not create a lease.
- Binance leases are checked outside US market hours as well.
- Heartbeat first invokes Commentator; Analyst runs only when escalation is requested and cooldown permits.

There is currently no API that lists all active lease symbols. `activeLeaseSymbols()` exists in `ai/leases.ts`, but it is not exposed.

## Data and Configuration Notes

- Persistent chart/data DB: `journal/charts/data/app.db`.
- Generated charts: `journal/charts/data/*.json`.
- Never print or commit `.env`, `~/.codex/auth.json`, OAuth tokens, or API keys.
- Codex OAuth is read from `~/.codex/auth.json`.
- FRED and SEC configuration was added earlier; revalidate through the project if future behavior suggests otherwise.
- Electron Longbridge credentials are stored via Electron safeStorage and may differ from the Web/.env setup. Logs may show `longbridge credentials not configured` in Electron until configured there. This does not block Binance contracts.

## Verification History

After the latest upstream rebase, the full suite passed:

```text
Core:    589 passed
Server:  196 passed
Web:     156 passed
Desktop: 210 passed, 1 skipped
All four workspace typechecks passed
```

For the Electron OAuth fix specifically:

```text
AgentSession test: 9/9 passed
Core typecheck passed
Desktop typecheck passed
Desktop production build passed
Real Electron LABUSDT analysis completed and wrote a chart
```

The Desktop build emits an existing `@tsuki-hono/common`/Zod warning and dynamic-import optimization warnings. They did not prevent the build or runtime verification.

## Upstream Update Workflow

Before syncing, commit local work. Then:

```bash
git fetch upstream main
git fetch origin
git rebase upstream/main
```

After resolving conflicts and running tests:

```bash
git push --force-with-lease origin feature/binance-perp-v2
git push origin upstream/main:main
```

Use `--force-with-lease`, never an unconditional force push. Keep Binance changes in focused commits to reduce future conflicts.

## Known Limitations / Follow-ups

- No Binance account access or order execution.
- No USDC, COIN-M, spot, options, or OKX provider yet.
- Liquidations are memory-only and reset when the process restarts.
- Dedicated Binance kline WebSocket is not implemented; REST polling is the fallback.
- Some relative-volume and intraday level logic still contains US equity session assumptions.
- TradFi perpetual news, earnings, SEC, and FRED context are not automatically mapped by underlying asset.
- The root `RUN.md` Electron section still shows the older `dev:desktop` command and does not mention `ELECTRON_RUN_AS_NODE`; consider updating it.
- Consider exposing a read-only active-leases diagnostic endpoint/UI if monitoring visibility is needed.


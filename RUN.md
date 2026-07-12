# Kansoku 启动与停止

新版项目需要 Node.js 22。每个新终端先执行：

```bash
source ~/.nvm/nvm.sh
nvm use 22
```

## 启动 Web 版

```bash
cd /Users/nanmener/Github/kansoku
COREPACK_ENABLE_AUTO_PIN=0 pnpm start
```

访问 `http://localhost:5199`。当前终端按 `Ctrl+C` 可停止。

## 找不到原终端时停止

```bash
kill $(lsof -tiTCP:5199 -sTCP:LISTEN)
```

确认端口：

```bash
lsof -nP -iTCP:5199 -sTCP:LISTEN
```

进程无响应时才使用：

```bash
kill -9 $(lsof -tiTCP:5199 -sTCP:LISTEN)
```

## 开发模式

```bash
cd /Users/nanmener/Github/kansoku
COREPACK_ENABLE_AUTO_PIN=0 pnpm dev
```

## Electron 桌面版

注意：系统环境中可能包含 `ELECTRON_RUN_AS_NODE=1`，启动 Electron 进程前必须将其移除。

已有构建产物时直接运行：

```bash
cd /Users/nanmener/Github/kansoku/app
env -u ELECTRON_RUN_AS_NODE COREPACK_ENABLE_AUTO_PIN=0 corepack pnpm --filter @trade/desktop start
```

代码修改后重新构建并运行：

```bash
cd /Users/nanmener/Github/kansoku/app
COREPACK_ENABLE_AUTO_PIN=0 corepack pnpm --filter @trade/desktop build
env -u ELECTRON_RUN_AS_NODE COREPACK_ENABLE_AUTO_PIN=0 corepack pnpm --filter @trade/desktop start
```

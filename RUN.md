# Kansoku 启动与停止

## 启动程序

在终端执行：

```bash
cd /Users/nanmener/Github/kansoku/app
COREPACK_ENABLE_AUTO_PIN=0 pnpm start
```

启动后访问：

```text
http://localhost:5199
```

保持该终端窗口运行。需要在当前终端停止程序时，按 `Ctrl+C`。

## 检查程序是否正在运行

```bash
lsof -nP -iTCP:5199 -sTCP:LISTEN
```

有输出表示程序正在运行；没有输出表示程序已停止。

## 找不到启动终端时停止程序

正常停止占用 5199 端口的程序：

```bash
kill $(lsof -tiTCP:5199 -sTCP:LISTEN)
```

然后确认端口已经释放：

```bash
lsof -nP -iTCP:5199 -sTCP:LISTEN
```

如果进程没有响应，再使用强制停止：

```bash
kill -9 $(lsof -tiTCP:5199 -sTCP:LISTEN)
```

`kill -9` 仅作为最后手段使用。

## 重启程序

先停止：

```bash
kill $(lsof -tiTCP:5199 -sTCP:LISTEN)
```

再启动：

```bash
cd /Users/nanmener/Github/kansoku/app
COREPACK_ENABLE_AUTO_PIN=0 pnpm start
```

## 开发模式

需要代码变更后自动重启时：

```bash
cd /Users/nanmener/Github/kansoku/app
COREPACK_ENABLE_AUTO_PIN=0 pnpm dev
```

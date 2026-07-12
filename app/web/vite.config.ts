import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { createLogger, defineConfig, type LogErrorOptions, type LogOptions } from "vite";

const KERNEL_PORT = Number(process.env.KERNEL_PORT || 5200);
const KERNEL_URL = `http://localhost:${KERNEL_PORT}`;

// dev:desktop 模式没有独立 kernel（实时走 Electron IPC），非特权上下文对 /api/ws 的
// 代理必然 ECONNREFUSED——属预期噪音，过滤掉避免刷屏；其他日志照常，pnpm dev 不受影响。
const logger = createLogger();
const isProxyNoise = (msg: unknown) =>
  typeof msg === "string" && (msg.includes("proxy error") || msg.includes("ECONNREFUSED"));
const baseError = logger.error;
const baseWarn = logger.warn;
logger.error = (msg: string, options?: LogErrorOptions) => {
  if (isProxyNoise(msg)) return;
  baseError(msg, options);
};
logger.warn = (msg: string, options?: LogOptions) => {
  if (isProxyNoise(msg)) return;
  baseWarn(msg, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: {
    port: 5199,
    proxy: {
      "/api": { target: KERNEL_URL, ws: true },
      "/legacy": { target: KERNEL_URL },
    },
  },
});

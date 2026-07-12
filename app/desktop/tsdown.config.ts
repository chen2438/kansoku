import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: "src/main.ts",
    outDir: "dist-main",
    format: "esm",
    platform: "node",
    // pi-ai loads OAuth implementations through variable relative imports;
    // bundling relocates the loader without copying those runtime modules.
    deps: {
      alwaysBundle: ["electron-window-state"],
      neverBundle: ["electron", "better-sqlite3", "longbridge", "@earendil-works/pi-ai"],
    },
    dts: false,
    clean: true,
  },
  {
    entry: "src/preload.ts",
    outDir: "dist-preload",
    format: "cjs",
    platform: "node",
    deps: { neverBundle: ["electron"] },
    dts: false,
    clean: true,
  },
]);

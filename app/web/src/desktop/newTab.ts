import type { MouseEvent } from "react";
import { showContextMenu } from "../ui";

// 桌面端标签控制器注册的"在新标签页打开路由"入口；web 端不注册（无应用内标签）。
let opener: ((route: string) => void) | null = null;

export function __setNewTabOpener(fn: ((route: string) => void) | null): void {
  opener = fn;
}

export function canOpenInNewTab(): boolean {
  return opener !== null;
}

export function openRouteInNewTab(route: string): void {
  opener?.(route);
}

// 右键一个标的 → "在新标签页打开"。仅桌面端生效；web 端不拦截，走浏览器默认菜单。
export function openSymbolContextMenu(symbol: string, event: MouseEvent): void {
  if (!opener) return;
  event.preventDefault();
  showContextMenu([
    {
      label: "在新标签页打开",
      onClick: () => openRouteInNewTab(`/symbol/${encodeURIComponent(symbol)}`),
    },
  ]);
}

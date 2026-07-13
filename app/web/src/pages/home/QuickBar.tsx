import { useState } from "react";
import { navigate } from "../../router";
import { listRecentSymbols } from "../../recentCharts";
import { openSymbolContextMenu } from "../../desktop/newTab";
import { Chip, Input } from "../../ui";
import { client } from "../../client";
import { errorMessage } from "../../api";

function normalizeSymbol(raw: string): string | null {
  let sym = raw.trim().toUpperCase();
  if (!sym) return null;
  if (/^[A-Z0-9]+USDT$/.test(sym)) return sym;
  if (!sym.includes(".")) sym += ".US";
  return /^[A-Z0-9.]+$/.test(sym) ? sym : null;
}

export function QuickBar({ shortcuts }: { shortcuts: string[] }) {
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [inputError, setInputError] = useState<string | null>(null);
  const shortcutSet = new Set(shortcuts);
  const recent = listRecentSymbols().filter((s) => !shortcutSet.has(s.symbol));

  const go = async () => {
    const sym = normalizeSymbol(input);
    if (!sym) { setInputError("请输入有效的标的代码"); return; }
    setChecking(true); setInputError(null);
    try {
      const result = await client.symbols.validate({ sym });
      setInput(""); navigate(`/symbol/${encodeURIComponent(result.symbol)}`);
    } catch (error) { setInputError(errorMessage(error)); }
    finally { setChecking(false); }
  };

  return (
    <div className="quickbar">
      <div className="quickbar-entry"><Input
        className="quickbar-input"
        placeholder={checking ? "正在验证…" : "代码直达，如 MRVL / BTCUSDT"}
        value={input}
        disabled={checking}
        aria-invalid={Boolean(inputError)}
        onChange={(e) => { setInput(e.target.value); setInputError(null); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void go();
        }}
      />{inputError && <span className="quickbar-error">{inputError}</span>}</div>
      {shortcuts.map((sym) => (
        <Chip key={sym} className="quickbar-shortcut" href={`/symbol/${encodeURIComponent(sym)}`} onContextMenu={(e) => openSymbolContextMenu(sym, e)}>
          {sym.replace(/\.US$/, "")}
        </Chip>
      ))}
      {recent.length > 0 && (
        <span className="quickbar-recent">
          最近：
          {recent.map((s) => (
            <a key={s.symbol} href={`/symbol/${encodeURIComponent(s.symbol)}`} onContextMenu={(e) => openSymbolContextMenu(s.symbol, e)}>
              {s.symbol.replace(/\.US$/, "")}
            </a>
          ))}
        </span>
      )}
    </div>
  );
}

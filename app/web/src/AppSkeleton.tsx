function isElectronShell(): boolean {
  return typeof navigator !== "undefined" && /\bElectron\b/.test(navigator.userAgent);
}

function Bone({ className = "" }: { className?: string }) {
  return <div className={`app-skeleton-bone${className ? ` ${className}` : ""}`} />;
}

function QuoteCellBone() {
  return (
    <div className="quote-cell app-skeleton-quote" aria-hidden="true">
      <Bone className="app-skeleton-bone--qc-sym" />
      <Bone className="app-skeleton-bone--qc-price" />
      <Bone className="app-skeleton-bone--qc-pct" />
    </div>
  );
}

export function AppSkeleton() {
  const desktop = isElectronShell();

  return (
    <div
      className={`app-skeleton${desktop ? " app-skeleton--desktop" : ""}`}
      aria-busy="true"
      aria-label="加载中"
    >
      {desktop ? (
        <div className="app-skeleton-titlebar">
          <div className="app-skeleton-traffic" />
          <div className="app-skeleton-tabstrip">
            <Bone className="app-skeleton-bone--tab" />
          </div>
          <div className="app-skeleton-actions">
            <Bone className="app-skeleton-bone--btn" />
            <Bone className="app-skeleton-bone--icon" />
          </div>
        </div>
      ) : (
        <div className="global-topbar app-skeleton-web-topbar" aria-hidden="true">
          <Bone className="app-skeleton-bone--btn" />
          <Bone className="app-skeleton-bone--icon" />
        </div>
      )}

      <div className="page home-page">
        <h1>盘面</h1>
        <div className="sub">实时行情与持仓</div>

        <div className="quote-bar" aria-hidden="true">
          <QuoteCellBone />
          <QuoteCellBone />
          <QuoteCellBone />
          <QuoteCellBone />
          <QuoteCellBone />
        </div>

        <div className="quickbar" aria-hidden="true">
          <Bone className="app-skeleton-bone--input" />
          <Bone className="app-skeleton-bone--chip" />
          <Bone className="app-skeleton-bone--chip" />
        </div>

        <div className="cross-section-switcher" aria-hidden="true">
          <Bone className="app-skeleton-bone--date" />
        </div>

        <div className="home-grid">
          <div className="home-main">
            <div className="section-title">Binance 持仓</div>
            <div className="card positions-card app-skeleton-positions" aria-hidden="true">
              <div className="app-skeleton-positions-summary">
                <Bone className="app-skeleton-bone--stat" />
                <Bone className="app-skeleton-bone--stat" />
                <Bone className="app-skeleton-bone--stat" />
              </div>
              <div className="app-skeleton-positions-rows">
                <Bone className="app-skeleton-bone--row" />
                <Bone className="app-skeleton-bone--row" />
                <Bone className="app-skeleton-bone--row" />
              </div>
            </div>
            <div className="cross-section-charts" aria-hidden="true">
              <Bone className="app-skeleton-bone--chart-title" />
              <Bone className="app-skeleton-bone--chart" />
            </div>
          </div>
          <div className="home-side">
            <div className="section-title">长桥持仓</div>
            <div className="card positions-card app-skeleton-positions" aria-hidden="true">
              <div className="app-skeleton-positions-summary">
                <Bone className="app-skeleton-bone--stat" />
                <Bone className="app-skeleton-bone--stat" />
                <Bone className="app-skeleton-bone--stat" />
                <Bone className="app-skeleton-bone--stat" />
              </div>
              <div className="app-skeleton-positions-rows">
                <Bone className="app-skeleton-bone--row" />
                <Bone className="app-skeleton-bone--row" />
                <Bone className="app-skeleton-bone--row" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

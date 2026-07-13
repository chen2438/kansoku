import { beforeEach, describe, expect, it, vi } from "vitest";

const models = vi.hoisted(() => ({ aiConfig: vi.fn() }));
const analyst = vi.hoisted(() => ({ runAnalyst: vi.fn() }));
const batch = vi.hoisted(() => ({ startBinanceTopAnalysis: vi.fn(), binanceTopAnalysisState: vi.fn() }));

vi.mock("../../packages/core/src/ai/models.js", () => models);
vi.mock("../../packages/core/src/ai/analyst.js", () => analyst);
vi.mock("../../packages/core/src/ai/binanceBatch.js", () => batch);

const { tsukiRequest } = await import("./helpers.js");

describe("POST /:sym/reassess", () => {
  beforeEach(() => {
    models.aiConfig.mockReset();
    analyst.runAnalyst.mockReset();
    batch.startBinanceTopAnalysis.mockReset();
    batch.binanceTopAnalysisState.mockReset();
  });

  it("returns started:false when the analyst layer is disabled", async () => {
    models.aiConfig.mockReturnValue({ commentModel: null, analystModel: null });
    const res = await tsukiRequest("/api/symbols/MU/reassess", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { started: false, reason: "analyst layer disabled" } });
    expect(analyst.runAnalyst).not.toHaveBeenCalled();
  });

  it("starts a manual run and returns started:true", async () => {
    models.aiConfig.mockReturnValue({ commentModel: null, analystModel: { id: "m" } });
    analyst.runAnalyst.mockReturnValue({ started: true, done: Promise.resolve() });
    const res = await tsukiRequest("/api/symbols/MU/reassess", { method: "POST" });
    expect(await res.json()).toEqual({ ok: true, data: { started: true } });
    expect(analyst.runAnalyst).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "MU.US", origin: "manual" }),
    );
  });

  it("surfaces started:false with the reason when a run is already in flight", async () => {
    models.aiConfig.mockReturnValue({ commentModel: null, analystModel: { id: "m" } });
    analyst.runAnalyst.mockReturnValue({ started: false, reason: "already running" });
    const res = await tsukiRequest("/api/symbols/MU/reassess", { method: "POST" });
    expect(await res.json()).toEqual({ ok: true, data: { started: false, reason: "already running" } });
  });
});

describe("Binance Top volume analysis routes", () => {
  it("starts a batch through the static route", async () => {
    models.aiConfig.mockReturnValue({ commentModel: null, analystModel: { id: "m" } });
    batch.startBinanceTopAnalysis.mockResolvedValue({ id: "batch-1", status: "running", startedAt: "now", items: [] });
    const res = await tsukiRequest("/api/symbols/binance/top-volume-analysis", { method: "POST" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.id).toBe("batch-1");
    expect(batch.startBinanceTopAnalysis).toHaveBeenCalledWith({});
  });

  it("forwards an explicitly confirmed analysis-and-trade request", async () => {
    models.aiConfig.mockReturnValue({ commentModel: null, analystModel: { id: "m" } });
    batch.startBinanceTopAnalysis.mockResolvedValue({ id: "batch-2", mode: "analysis_and_trade", status: "running", startedAt: "now", items: [] });
    const res = await tsukiRequest("/api/symbols/binance/top-volume-analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoTrade: true, confirmed: true }),
    });
    expect(res.status).toBe(200);
    expect(batch.startBinanceTopAnalysis).toHaveBeenCalledWith({ autoTrade: true, confirmed: true });
  });

  it("returns the current batch status", async () => {
    batch.binanceTopAnalysisState.mockReturnValue({ id: "batch-1", status: "completed", startedAt: "now", items: [] });
    const res = await tsukiRequest("/api/symbols/binance/top-volume-analysis/status");
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("completed");
  });
});

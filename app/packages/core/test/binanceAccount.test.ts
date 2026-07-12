import { describe, expect, it } from "vitest";
import { signQuery } from "../src/services/marketdata/binanceAccount.js";

describe("binance account signing", () => {
  // Binance 官方文档的已知示例（HMAC-SHA256），用来锁定签名算法正确。
  it("matches the documented HMAC-SHA256 example", () => {
    const secret = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";
    const query =
      "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559";
    expect(signQuery(secret, query)).toBe("c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });

  it("is deterministic and secret-sensitive", () => {
    const q = "timestamp=1700000000000&recvWindow=5000";
    expect(signQuery("abc", q)).toBe(signQuery("abc", q));
    expect(signQuery("abc", q)).not.toBe(signQuery("abd", q));
  });
});

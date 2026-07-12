import { Body, Controller, Delete, Get, Post } from "@tsuki-hono/common";
import { binanceAccountService } from "../../../../packages/core/src/modules/binanceAccount/binanceAccount.service.js";
import type { BinanceAccountConnectInput } from "../../../../packages/core/src/contract/binanceAccount.js";

@Controller("binanceAccount")
export class BinanceAccountController {
  @Get("/status")
  async getStatus() {
    return { ok: true, data: await binanceAccountService.status() };
  }

  @Post("/connect")
  async postConnect(@Body() body: BinanceAccountConnectInput) {
    return { ok: true, data: await binanceAccountService.connect(body) };
  }

  @Delete("/disconnect")
  async delDisconnect() {
    return { ok: true, data: await binanceAccountService.disconnect() };
  }

  @Get("/balance")
  async getBalance() {
    return { ok: true, data: await binanceAccountService.balance() };
  }

  @Get("/positions")
  async getPositions() {
    return { ok: true, data: await binanceAccountService.positions() };
  }

  @Get("/open-orders")
  async getOpenOrders() {
    return { ok: true, data: await binanceAccountService.openOrders() };
  }
}

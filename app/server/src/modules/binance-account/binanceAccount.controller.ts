import { Body, Controller, Delete, Get, Post } from "@tsuki-hono/common";
import { binanceAccountService } from "../../../../packages/core/src/modules/binanceAccount/binanceAccount.service.js";
import type {
  BinanceAccountConnectInput,
  BinanceCancelTestnetOrderInput,
  BinanceCloseAllTestnetPositionsInput,
  BinanceCloseTestnetPositionInput,
  BinancePlaceTestnetOrderInput,
} from "../../../../packages/core/src/contract/binanceAccount.js";

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

  @Get("/closed-position-history")
  async getClosedPositionHistory() {
    return { ok: true, data: await binanceAccountService.closedPositionHistory() };
  }

  @Get("/open-orders")
  async getOpenOrders() {
    return { ok: true, data: await binanceAccountService.openOrders() };
  }

  @Post("/testnet/orders")
  async postTestnetOrder(@Body() body: BinancePlaceTestnetOrderInput) {
    return { ok: true, data: await binanceAccountService.placeTestnetOrder(body) };
  }

  @Post("/testnet/positions/close")
  async postCloseTestnetPosition(@Body() body: BinanceCloseTestnetPositionInput) {
    return { ok: true, data: await binanceAccountService.closeTestnetPosition(body) };
  }

  @Post("/testnet/positions/close-all")
  async postCloseAllTestnetPositions(@Body() body: BinanceCloseAllTestnetPositionsInput) {
    return { ok: true, data: await binanceAccountService.closeAllTestnetPositions(body) };
  }

  @Post("/testnet/orders/cancel")
  async postCancelTestnetOrder(@Body() body: BinanceCancelTestnetOrderInput) {
    return { ok: true, data: await binanceAccountService.cancelTestnetOrder(body) };
  }
}

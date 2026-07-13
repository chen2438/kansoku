import { IpcMethod, IpcService } from "electron-ipc-decorator";
import type { BinanceAccountApi } from "../../../packages/core/src/contract/index.js";
import { binanceAccountService } from "../../../packages/core/src/modules/binanceAccount/binanceAccount.service.js";
import { toEnvelope, type WrapEnvelope } from "./envelope.js";

export class BinanceAccountIpc extends IpcService implements WrapEnvelope<BinanceAccountApi> {
  static readonly groupName = "binanceAccount";

  @IpcMethod()
  status() {
    return toEnvelope("binanceAccount.status", () => binanceAccountService.status());
  }

  @IpcMethod()
  connect(input: Parameters<BinanceAccountApi["connect"]>[0]) {
    return toEnvelope("binanceAccount.connect", () => binanceAccountService.connect(input));
  }

  @IpcMethod()
  disconnect() {
    return toEnvelope("binanceAccount.disconnect", () => binanceAccountService.disconnect());
  }

  @IpcMethod()
  balance() {
    return toEnvelope("binanceAccount.balance", () => binanceAccountService.balance());
  }

  @IpcMethod()
  positions() {
    return toEnvelope("binanceAccount.positions", () => binanceAccountService.positions());
  }

  @IpcMethod()
  closedPositionHistory() {
    return toEnvelope("binanceAccount.closedPositionHistory", () => binanceAccountService.closedPositionHistory());
  }

  @IpcMethod()
  openOrders() {
    return toEnvelope("binanceAccount.openOrders", () => binanceAccountService.openOrders());
  }

  @IpcMethod()
  placeTestnetOrder(input: Parameters<BinanceAccountApi["placeTestnetOrder"]>[0]) {
    return toEnvelope("binanceAccount.placeTestnetOrder", () => binanceAccountService.placeTestnetOrder(input));
  }

  @IpcMethod()
  closeTestnetPosition(input: Parameters<BinanceAccountApi["closeTestnetPosition"]>[0]) {
    return toEnvelope("binanceAccount.closeTestnetPosition", () => binanceAccountService.closeTestnetPosition(input));
  }

  @IpcMethod()
  closeAllTestnetPositions(input: Parameters<BinanceAccountApi["closeAllTestnetPositions"]>[0]) {
    return toEnvelope("binanceAccount.closeAllTestnetPositions", () => binanceAccountService.closeAllTestnetPositions(input));
  }

  @IpcMethod()
  cancelTestnetOrder(input: Parameters<BinanceAccountApi["cancelTestnetOrder"]>[0]) {
    return toEnvelope("binanceAccount.cancelTestnetOrder", () => binanceAccountService.cancelTestnetOrder(input));
  }
}

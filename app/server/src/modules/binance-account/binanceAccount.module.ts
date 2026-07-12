import { Module } from "@tsuki-hono/common";
import { BinanceAccountController } from "./binanceAccount.controller.js";

@Module({
  controllers: [BinanceAccountController],
})
export class BinanceAccountModule {}

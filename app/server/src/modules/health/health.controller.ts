import { Controller, Get } from "@tsuki-hono/common";
import { healthService } from "../../../../packages/core/src/modules/health/health.service.js";
import { activeLeaseSymbols } from "../../../../packages/core/src/ai/leases.js";

@Controller("health")
export class HealthController {
  @Get("/")
  async getHealth() {
    const data = await healthService.get();
    return { ok: true, data };
  }

  @Get("/leases")
  getLeases() {
    return { ok: true, data: activeLeaseSymbols() };
  }
}

import { Get, JsonController } from "routing-controllers";
import { Service } from "typedi";
import { ConfigService } from "../services/config.service";

@Service()
@JsonController("/health")
export class HealthController {
  constructor(private readonly configService: ConfigService) {}

  @Get("/")
  index() {
    return {
      success: true,
      data: {
        service: "backend-new",
        env: this.configService.config.env
      }
    };
  }
}

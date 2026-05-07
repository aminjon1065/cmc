import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { UsersModule } from "../users/users.module";
import { TenantsModule } from "../tenants/tenants.module";
import type { AppConfig } from "../../config/configuration";

@Module({
  imports: [
    UsersModule,
    TenantsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        secret: config.get("JWT_SECRET", { infer: true }),
        signOptions: {
          expiresIn: config.get("JWT_EXPIRES_IN", { infer: true }),
          issuer: config.get("JWT_ISSUER", { infer: true }),
        },
      }),
      global: true,
    }),
  ],
  providers: [AuthService],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}

import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { AuthRateLimitSpecs } from "./auth-rate-limit.specs";
import { SessionsModule } from "./sessions.module";
import { UsersModule } from "../users/users.module";
import { TenantsModule } from "../tenants/tenants.module";
import { MfaModule } from "../mfa/mfa.module";
import type { AppConfig } from "../../config/configuration";

@Module({
  imports: [
    UsersModule,
    TenantsModule,
    MfaModule,
    SessionsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        secret: config.get("JWT_SECRET", { infer: true }),
        signOptions: {
          // Default lifetime; AuthService overrides per call so refresh
          // and access tokens can have different expirations.
          expiresIn: config.get("JWT_ACCESS_TTL", { infer: true }),
          issuer: config.get("JWT_ISSUER", { infer: true }),
        },
      }),
      global: true,
    }),
  ],
  providers: [AuthService, AuthRateLimitSpecs],
  controllers: [AuthController],
  // Re-export SessionsModule so existing consumers that import AuthModule
  // (e.g. PasswordResetModule) keep resolving SessionsService unchanged.
  exports: [AuthService, AuthRateLimitSpecs, SessionsModule],
})
export class AuthModule {}

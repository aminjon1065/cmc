import {
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import type { LoginResponse, AuthUser, JwtClaims } from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { UsersService } from "../users/users.service";
import { TenantsService } from "../tenants/tenants.service";
import { AuditService } from "../audit/audit.service";

export type LoginAttempt = {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly tenants: TenantsService,
    private readonly audit: AuditService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async login(attempt: LoginAttempt): Promise<LoginResponse> {
    const candidates = await this.users.findActiveByEmailGlobal(attempt.email);

    // To resist account-enumeration timing attacks, always run a verify even
    // when no user matches. Argon2 dominates the request cost; running once
    // against a constant hash equalises the timing of the failure path.
    if (candidates.length === 0) {
      await this.dummyVerify();
      await this.recordLoginFailure(attempt, null, null, "user_not_found");
      throw new UnauthorizedException("Invalid email or password");
    }

    if (candidates.length > 1) {
      // Multiple tenants share this email. We need a tenant hint — not
      // implemented yet (tenant picker UI is a later task). Reject with a
      // generic error so callers don't learn anything from the response.
      await this.dummyVerify();
      await this.recordLoginFailure(
        attempt,
        null,
        null,
        "ambiguous_tenant",
      );
      throw new UnauthorizedException("Invalid email or password");
    }

    const user = candidates[0]!;

    if (!user.passwordHash) {
      // SSO-only account, no local password set.
      await this.dummyVerify();
      await this.recordLoginFailure(
        attempt,
        user.id,
        user.tenantId,
        "no_password_set",
      );
      throw new UnauthorizedException("Invalid email or password");
    }

    const ok = await argon2.verify(user.passwordHash, attempt.password);
    if (!ok) {
      await this.recordLoginFailure(
        attempt,
        user.id,
        user.tenantId,
        "wrong_password",
      );
      throw new UnauthorizedException("Invalid email or password");
    }

    const tenant = await this.tenants.findById(user.tenantId);
    if (!tenant || tenant.deletedAt) {
      await this.recordLoginFailure(
        attempt,
        user.id,
        user.tenantId,
        "tenant_not_active",
      );
      throw new UnauthorizedException("Invalid email or password");
    }

    await this.users.markLoggedIn(user.id);

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
    };

    const claims: Omit<JwtClaims, "iat" | "exp"> = {
      sub: user.id,
      tid: tenant.id,
      ts: tenant.slug,
      email: user.email,
    };

    const accessToken = await this.jwt.signAsync(claims);

    // Decode to read the actual exp the JwtModule applied.
    const decoded = this.jwt.decode<JwtClaims>(accessToken);
    const expiresAt = new Date((decoded?.exp ?? 0) * 1000).toISOString();

    await this.audit.record({
      tenantId: tenant.id,
      actorId: user.id,
      actorType: "user",
      action: "user.login",
      resourceType: "user",
      resourceId: user.id,
      outcome: "success",
      ip: attempt.ip ?? null,
      userAgent: attempt.userAgent ?? null,
    });

    return { user: authUser, accessToken, expiresAt };
  }

  /**
   * Hash a plaintext password with argon2id. Used by the seed script and
   * by future user-management endpoints.
   */
  static async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
    });
  }

  // --- internal helpers ---

  private async dummyVerify(): Promise<void> {
    // Pre-computed hash of a fixed password — verifying it always returns
    // false but pays roughly the same CPU cost as a real verify.
    const constant =
      "$argon2id$v=19$m=19456,t=2,p=1$YWFhYWFhYWFhYWFhYWFhYQ$nKp4F2k8tIZL6Yj5y0R2xR7SrJYqQ8a8m6gQc6Y4kQc";
    try {
      await argon2.verify(constant, "definitely-wrong-password");
    } catch {
      // hash format errors are expected if the constant ever decays;
      // ignore — the goal is constant-time, not correctness.
    }
  }

  private async recordLoginFailure(
    attempt: LoginAttempt,
    actorId: string | null,
    tenantId: string | null,
    reason: string,
  ): Promise<void> {
    await this.audit.record({
      tenantId,
      actorId,
      actorType: actorId ? "user" : "anonymous",
      action: "user.login",
      resourceType: "user",
      resourceId: actorId,
      outcome: "failure",
      ip: attempt.ip ?? null,
      userAgent: attempt.userAgent ?? null,
      metadata: { email: attempt.email, reason },
    });
  }
}

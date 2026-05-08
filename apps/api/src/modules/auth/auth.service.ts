import {
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as argon2 from "argon2";
import type {
  LoginResponse,
  RefreshResponse,
  TokenBundle,
  AuthUser,
  JwtClaims,
} from "@cmc/contracts";
import type { AppConfig } from "../../config/configuration";
import { UsersService } from "../users/users.service";
import { TenantsService } from "../tenants/tenants.service";
import { AuditService } from "../audit/audit.service";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { SessionsService } from "./sessions.service";

export type LoginAttempt = {
  email: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
};

export type RefreshAttempt = {
  refreshToken: string;
  ip?: string | null;
  userAgent?: string | null;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly tenants: TenantsService,
    private readonly sessions: SessionsService,
    private readonly audit: AuditService,
    private readonly tenantDb: TenantDatabaseService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // ---------- Login ----------

  /**
   * Login is special: it runs *before* tenant context exists, so the
   * service hops into a privileged transaction (RLS bypass) for the
   * cross-tenant user lookup, then the rest of the work — including
   * session creation — happens inside that same transaction so the
   * session insert is co-located with the user lookup.
   */
  async login(attempt: LoginAttempt): Promise<LoginResponse> {
    return this.tenantDb.runPrivileged(async () => this.doLogin(attempt));
  }

  private async doLogin(attempt: LoginAttempt): Promise<LoginResponse> {
    const candidates = await this.users.findActiveByEmailGlobal(attempt.email);

    if (candidates.length === 0) {
      await this.dummyVerify();
      await this.recordLoginFailure(attempt, null, null, "user_not_found");
      throw new UnauthorizedException("Invalid email or password");
    }

    if (candidates.length > 1) {
      await this.dummyVerify();
      await this.recordLoginFailure(attempt, null, null, "ambiguous_tenant");
      throw new UnauthorizedException("Invalid email or password");
    }

    const user = candidates[0]!;

    if (!user.passwordHash) {
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

    // Create the session (and its refresh token) — issuing the access
    // token requires the session id, so we create the row first.
    const { session, plainRefreshToken } = await this.sessions.create({
      tenantId: tenant.id,
      userId: user.id,
      ip: attempt.ip ?? null,
      userAgent: attempt.userAgent ?? null,
      refreshTokenLifetimeSec: this.config.get("JWT_REFRESH_TTL_SEC", {
        infer: true,
      }),
    });

    const tokens = await this.signAccessToken({
      sub: user.id,
      tid: tenant.id,
      ts: tenant.slug,
      sid: session.id,
      email: user.email,
    });

    const authUser: AuthUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
    };

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
      metadata: { sessionId: session.id, familyId: session.familyId },
    });

    return {
      user: authUser,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshToken: plainRefreshToken,
      refreshTokenExpiresAt: session.expiresAt.toISOString(),
    };
  }

  // ---------- Refresh ----------

  /**
   * Rotate a refresh token. Runs in privileged scope: cross-tenant user
   * lookup is needed because the refresh token alone identifies the user.
   * Replay (presenting a previously-rotated token) revokes the entire
   * family — handled inside SessionsService.rotate.
   */
  async refresh(attempt: RefreshAttempt): Promise<RefreshResponse> {
    return this.tenantDb.runPrivileged(async () => this.doRefresh(attempt));
  }

  private async doRefresh(attempt: RefreshAttempt): Promise<RefreshResponse> {
    const result = await this.sessions.rotate(
      attempt.refreshToken,
      this.config.get("JWT_REFRESH_TTL_SEC", { infer: true }),
      attempt.ip ?? null,
      attempt.userAgent ?? null,
    );

    if (!result.ok) {
      await this.audit.record({
        actorType: "anonymous",
        action: "auth.refresh",
        resourceType: "session",
        outcome: "failure",
        ip: attempt.ip ?? null,
        userAgent: attempt.userAgent ?? null,
        metadata: { reason: result.reason },
        durable: true,
      });
      throw new UnauthorizedException("Invalid refresh token");
    }

    const session = result.session;

    // Look up tenant + user to fill the new access JWT.
    const tenant = await this.tenants.findById(session.tenantId);
    const user = await this.users.findById(session.userId);
    if (!tenant || !user || tenant.deletedAt || user.deletedAt || !user.isActive) {
      await this.sessions.revoke(session.id, "admin");
      await this.audit.record({
        tenantId: session.tenantId,
        actorId: session.userId,
        actorType: "user",
        action: "auth.refresh",
        resourceType: "session",
        resourceId: session.id,
        outcome: "denied",
        metadata: { reason: "user_or_tenant_inactive" },
        durable: true,
      });
      throw new UnauthorizedException("Invalid refresh token");
    }

    const tokens = await this.signAccessToken({
      sub: user.id,
      tid: tenant.id,
      ts: tenant.slug,
      sid: session.id,
      email: user.email,
    });

    await this.audit.record({
      tenantId: tenant.id,
      actorId: user.id,
      actorType: "user",
      action: "auth.refresh",
      resourceType: "session",
      resourceId: session.id,
      outcome: "success",
      ip: attempt.ip ?? null,
      userAgent: attempt.userAgent ?? null,
      metadata: { familyId: session.familyId, parentId: session.parentId },
    });

    return {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshToken: result.plainRefreshToken,
      refreshTokenExpiresAt: session.expiresAt.toISOString(),
    };
  }

  // ---------- Logout ----------

  async logout(sessionId: string, actorId: string): Promise<void> {
    await this.sessions.revoke(sessionId, "logout");
    await this.audit.record({
      actorId,
      actorType: "user",
      action: "user.logout",
      resourceType: "session",
      resourceId: sessionId,
      outcome: "success",
    });
  }

  // ---------- Static helpers ----------

  static async hashPassword(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
    });
  }

  // ---------- Internal ----------

  private async signAccessToken(
    claims: Omit<JwtClaims, "iat" | "exp">,
  ): Promise<Pick<TokenBundle, "accessToken" | "accessTokenExpiresAt">> {
    const accessToken = await this.jwt.signAsync(claims, {
      expiresIn: this.config.get("JWT_ACCESS_TTL", { infer: true }),
    });
    const decoded = this.jwt.decode<JwtClaims>(accessToken);
    const accessTokenExpiresAt = new Date(
      (decoded?.exp ?? 0) * 1000,
    ).toISOString();
    return { accessToken, accessTokenExpiresAt };
  }

  private async dummyVerify(): Promise<void> {
    const constant =
      "$argon2id$v=19$m=19456,t=2,p=1$YWFhYWFhYWFhYWFhYWFhYQ$nKp4F2k8tIZL6Yj5y0R2xR7SrJYqQ8a8m6gQc6Y4kQc";
    try {
      await argon2.verify(constant, "definitely-wrong-password");
    } catch {
      // ignore — only goal is constant-time
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
      // Caller throws 401 right after — make sure the audit row survives
      // the request rollback.
      durable: true,
    });
  }
}

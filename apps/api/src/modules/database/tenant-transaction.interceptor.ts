import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, from, switchMap } from "rxjs";
import { TenantContextService } from "../../common/tenant-context/tenant-context.service";
import { TenantDatabaseService } from "./tenant-database.service";

/**
 * Wraps every authenticated HTTP handler in a single tenant-scoped
 * transaction so every query observed during the request automatically
 * sees `app.tenant_id` set, and RLS policies enforce isolation.
 *
 * Anonymous requests (no tenant context) pass through with no transaction
 * wrapper — services that need DB access in those paths must use
 * `runPrivileged(...)` explicitly.
 */
@Injectable()
export class TenantTransactionInterceptor implements NestInterceptor {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly tenantDb: TenantDatabaseService,
  ) {}

  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tc = this.tenantContext.getCurrent();
    if (!tc) {
      return next.handle();
    }

    return from(
      this.tenantDb.runForTenant(
        tc.tenantId,
        () =>
          // Bridge the rxjs handler back into the promise the transaction
          // is awaiting — first emission resolves, errors reject.
          new Promise<unknown[]>((resolve, reject) => {
            const collected: unknown[] = [];
            next.handle().subscribe({
              next: (v) => collected.push(v),
              error: reject,
              complete: () => resolve(collected),
            });
          }),
      ),
    ).pipe(switchMap((collected) => from(collected as unknown[])));
  }
}

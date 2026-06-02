import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NativeConnection, Worker } from "@temporalio/worker";
import type { AppConfig } from "../../config/configuration";
import { TenantDatabaseService } from "../database/tenant-database.service";
import { OutboxService } from "../events/outbox.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RbacService } from "../rbac/rbac.service";
import { buildCaseSlaActivities } from "./activities/case-sla.activities";
import { buildIncidentResponseActivities } from "./activities/incident-response.activities";
import { buildWorkflowInterpreterActivities } from "./activities/workflow-interpreter.activities";

/**
 * In-process Temporal worker (P3.1 / ADR-0045). Polls the task queue and runs
 * workflow + activity code. Gated on `TEMPORAL_ENABLED` + skipped in tests;
 * `@temporalio/worker` is dynamic-imported so it never enters jest. Workflows are
 * bundled from `./workflows` (determinism-safe); activities are built from
 * injected services (DB/outbox access) and run in this process.
 */
@Injectable()
export class TemporalWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TemporalWorker.name);
  private readonly enabled: boolean;
  private readonly isTest: boolean;
  private readonly address: string;
  private readonly namespace: string;
  private readonly taskQueue: string;
  private worker: Worker | null = null;
  private connection: NativeConnection | null = null;
  private runPromise: Promise<void> | null = null;

  constructor(
    private readonly db: TenantDatabaseService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly rbac: RbacService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get("TEMPORAL_ENABLED", { infer: true });
    this.isTest = config.get("NODE_ENV", { infer: true }) === "test";
    this.address = config.get("TEMPORAL_ADDRESS", { infer: true });
    this.namespace = config.get("TEMPORAL_NAMESPACE", { infer: true });
    this.taskQueue = config.get("TEMPORAL_TASK_QUEUE", { infer: true });
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled || this.isTest) return;
    const { Worker, NativeConnection } = await import("@temporalio/worker");
    this.connection = await NativeConnection.connect({ address: this.address });
    this.worker = await Worker.create({
      connection: this.connection,
      namespace: this.namespace,
      taskQueue: this.taskQueue,
      workflowsPath: require.resolve("./workflows"),
      activities: {
        ...buildCaseSlaActivities({ db: this.db, outbox: this.outbox }),
        ...buildIncidentResponseActivities({
          db: this.db,
          outbox: this.outbox,
          notifications: this.notifications,
          rbac: this.rbac,
        }),
        ...buildWorkflowInterpreterActivities({
          db: this.db,
          notifications: this.notifications,
        }),
      },
    });
    // run() resolves only on shutdown — keep the promise, don't await it here.
    this.runPromise = this.worker.run();
    this.logger.log(
      `temporal worker polling ${this.namespace}/${this.taskQueue} @ ${this.address}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.worker?.shutdown();
    if (this.runPromise) await this.runPromise.catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}

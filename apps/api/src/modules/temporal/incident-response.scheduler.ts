import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { TEMPORAL_CLIENT, type TemporalClient } from "./temporal-client";

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Incident-response scheduling policy (P3.2 / ADR-0046). Decides — from
 * severity — whether an incident warrants the response workflow, and translates
 * incident lifecycle into Temporal ops. Depends only on the gated
 * {@link TemporalClient} seam, so with Temporal off every call is a cheap noop.
 * Best-effort: a Temporal failure is logged, never thrown (must not break
 * incident CRUD). Wired into IncidentsService in P3.2b.
 */
@Injectable()
export class IncidentResponseScheduler {
  private readonly logger = new Logger(IncidentResponseScheduler.name);
  private readonly threshold: number;
  private readonly ackSlaSec: number;
  private readonly reminderIntervalSec: number;

  constructor(
    @Inject(TEMPORAL_CLIENT) private readonly temporal: TemporalClient,
    config: ConfigService<AppConfig, true>,
  ) {
    this.threshold = config.get("INCIDENT_RESPONSE_SEVERITY_THRESHOLD", {
      infer: true,
    });
    this.ackSlaSec = config.get("INCIDENT_ACK_SLA_SEC", { infer: true });
    this.reminderIntervalSec = config.get("INCIDENT_REMINDER_INTERVAL_SEC", {
      infer: true,
    });
  }

  /** Deterministic, one-per-incident workflow id (→ start is idempotent). */
  static workflowId(incidentId: string): string {
    return `incident-response:${incidentId}`;
  }

  /** Severity 1 = SEV-1; lower number = more severe → at/under threshold. */
  isSevere(severity: number): boolean {
    return severity <= this.threshold;
  }

  /** A new incident: start the response workflow iff it's severe enough. */
  async onCreated(
    tenantId: string,
    incidentId: string,
    severity: number,
  ): Promise<void> {
    if (this.isSevere(severity)) await this.start(tenantId, incidentId);
  }

  /**
   * Severity changed on an open incident: (re)start if now severe, else cancel.
   * Re-start atomically replaces a running timer (TERMINATE_EXISTING).
   */
  async onSeverityChanged(
    tenantId: string,
    incidentId: string,
    severity: number,
    isOpen: boolean,
  ): Promise<void> {
    if (this.isSevere(severity) && isOpen) {
      await this.start(tenantId, incidentId);
    } else {
      await this.cancel(incidentId);
    }
  }

  /** Cancel the response workflow (incident acknowledged late / resolved). */
  async cancel(incidentId: string): Promise<void> {
    try {
      await this.temporal.cancel(IncidentResponseScheduler.workflowId(incidentId));
    } catch (err) {
      this.logger.warn(`response cancel failed for ${incidentId}: ${msg(err)}`);
    }
  }

  private async start(tenantId: string, incidentId: string): Promise<void> {
    try {
      await this.temporal.start({
        workflowType: "incidentResponseWorkflow",
        workflowId: IncidentResponseScheduler.workflowId(incidentId),
        args: [
          {
            tenantId,
            incidentId,
            ackSlaSec: this.ackSlaSec,
            reminderIntervalSec: this.reminderIntervalSec,
          },
        ],
      });
      if (this.temporal.active) {
        this.logger.debug(`started incident-response for ${incidentId}`);
      }
    } catch (err) {
      this.logger.warn(`response start failed for ${incidentId}: ${msg(err)}`);
    }
  }
}

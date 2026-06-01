import type { BrandingCopy } from "@cmc/contracts";

/**
 * Tajikistan-CMC branding (P0.11 / ADR-0018).
 *
 * THIS FILE IS THE ONLY PLACE THE TJ-CMC SPECIFICS LIVE. The seed writes it to
 * the default tenant's `tenant_branding` row; the frontend reads it from the
 * API. Nothing here is referenced by application code — onboarding a different
 * first tenant means changing this seed value, not editing components.
 */
export const TJ_CMC_BRANDING: {
  localeDefault: string;
  logoUrl: string | null;
  copy: BrandingCopy;
  theme: Record<string, string>;
} = {
  localeDefault: "en",
  logoUrl: null,
  copy: {
    orgName: "Crisis Management Center",
    orgShort: "Civil Defense · TJ",
    country: "Tajikistan",
    statusLocation: "National Operational Status · Dushanbe",
    dataCenter: "National Data Center · Dushanbe",
    muralKicker: "Unified enterprise operational intelligence",
    muralHeadline:
      "Sovereign-grade crisis intelligence,\noperated at national scale.",
    muralSubcopy:
      "Geospatial · Realtime · Workflow · Audit · AI — converged into a single command surface for the Republic of Tajikistan's emergency operations.",
    buildLabel: "v2.6.0 · Build 2026.05.14",
    complianceLine: "ISO 27001 · SOC 2 Type II",
    metaTitle: "CMC · Operational Intelligence Platform",
    metaDescription:
      "Crisis Management Center · Committee of Emergency Situations and Civil Defense of Tajikistan",
  },
  theme: {},
};

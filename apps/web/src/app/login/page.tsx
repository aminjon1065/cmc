import type { Metadata } from "next";
import { Suspense } from "react";
import { LoginForm } from "@/components/login-form";
import { Emblem } from "@/components/cmc/emblem";

export const metadata: Metadata = {
  title: "Sign in",
};

export default function LoginPage() {
  return (
    <div
      className="flex min-h-screen w-full"
      style={{ background: "var(--c-bg-0)", color: "var(--c-fg-1)" }}
    >
      {/* Left mural — hidden on small screens */}
      <div
        className="relative hidden flex-1 overflow-hidden lg:block"
        style={{
          background:
            "linear-gradient(135deg, var(--c-bg-1) 0%, var(--c-bg-0) 100%)",
        }}
      >
        <svg
          className="absolute inset-0 opacity-40"
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid slice"
          viewBox="0 0 800 600"
          aria-hidden
        >
          <defs>
            <radialGradient id="lg" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#5b8def" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#5b8def" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="400" cy="300" r="300" fill="url(#lg)" />
          {Array.from({ length: 30 }).map((_, i) => (
            <ellipse
              key={i}
              cx="400"
              cy="300"
              rx={50 + i * 20}
              ry={28 + i * 12}
              fill="none"
              stroke="rgba(91,141,239,0.06)"
              strokeWidth="0.5"
            />
          ))}
          <path
            d="M0 460 L100 380 L180 420 L240 340 L320 400 L420 320 L520 380 L620 300 L720 360 L800 280 L800 600 L0 600 Z"
            fill="rgba(91,141,239,0.04)"
            stroke="rgba(91,141,239,0.18)"
            strokeWidth="0.8"
          />
          <path
            d="M0 500 L120 420 L210 460 L300 380 L400 440 L500 360 L620 420 L720 340 L800 400 L800 600 L0 600 Z"
            fill="rgba(91,141,239,0.06)"
          />
        </svg>

        <div className="absolute left-9 top-8 flex items-center gap-2.5">
          <Emblem size={32} />
          <div>
            <div className="text-[13px] font-semibold">
              Crisis Management Center
            </div>
            <div
              className="text-[10.5px]"
              style={{ color: "var(--c-fg-3)" }}
            >
              Civil Defense · TJ
            </div>
          </div>
        </div>

        <div
          className="absolute right-9 top-8 flex items-center gap-1.5 text-[10.5px]"
          style={{ color: "var(--c-fg-3)" }}
        >
          <span
            className="cmc-dot cmc-dot-pulse"
            style={{ background: "var(--c-ok)", color: "var(--c-ok)" }}
          />
          ALL SYSTEMS OPERATIONAL
        </div>

        <div className="absolute inset-x-9 bottom-9">
          <div className="cmc-label mb-3">
            Unified enterprise operational intelligence
          </div>
          <h1
            className="cmc-display mb-3.5 max-w-[480px] text-[36px] font-bold leading-[1.1]"
            style={{ letterSpacing: "-0.018em" }}
          >
            Sovereign-grade crisis intelligence,
            <br />
            operated at national scale.
          </h1>
          <p
            className="max-w-[460px] text-[12.5px] leading-relaxed"
            style={{ color: "var(--c-fg-3)" }}
          >
            Geospatial · Realtime · Workflow · Audit · AI — converged into a
            single command surface for the Republic of Tajikistan&apos;s
            emergency operations.
          </p>
          <div
            className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px]"
            style={{ color: "var(--c-fg-4)" }}
          >
            <span>v2.6.0 · Build 2026.05.14</span>
            <span>·</span>
            <span>National Data Center · Dushanbe</span>
            <span>·</span>
            <span>ISO 27001 · SOC 2 Type II</span>
          </div>
        </div>
      </div>

      {/* Right form */}
      <div
        className="flex w-full flex-col px-12 py-16 lg:w-[440px] lg:border-l"
        style={{ borderColor: "var(--c-line-2)" }}
      >
        <div className="cmc-label mb-1.5">Secure sign-in</div>
        <h2
          className="cmc-display mb-8 text-[26px] font-semibold"
          style={{ letterSpacing: "-0.015em" }}
        >
          Welcome back
        </h2>

        <Suspense fallback={<LoginFormSkeleton />}>
          <LoginForm />
        </Suspense>

        <div className="flex-1" />
        <p
          className="mt-5 text-[10px] leading-relaxed"
          style={{ color: "var(--c-fg-4)" }}
        >
          By signing in you accept the platform&apos;s Acceptable Use Policy.
          All actions are logged in a tamper-evident audit trail under §3.15 of
          the system specification.
        </p>
      </div>
    </div>
  );
}

function LoginFormSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div
        className="h-10 animate-pulse rounded-md"
        style={{ background: "var(--c-bg-3)" }}
      />
      <div
        className="h-10 animate-pulse rounded-md"
        style={{ background: "var(--c-bg-3)" }}
      />
      <div
        className="h-10 animate-pulse rounded-md"
        style={{ background: "var(--c-bg-3)" }}
      />
    </div>
  );
}

import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { LoginForm } from "@/components/login-form";
import { Emblem } from "@/components/cmc/emblem";
import { getPublicBranding } from "@/lib/branding";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("login");
  return { title: t("metaTitle") };
}

export default async function LoginPage() {
  const { copy } = await getPublicBranding();
  const t = await getTranslations("login");
  // Split the headline on its newline so the mural keeps its two-line layout
  // regardless of which tenant's copy is in play.
  const [headlineL1, headlineL2] = copy.muralHeadline.split("\n");
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
            <div className="text-[13px] font-semibold">{copy.orgName}</div>
            <div
              className="text-[10.5px]"
              style={{ color: "var(--c-fg-3)" }}
            >
              {copy.orgShort}
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
          {t("allSystems")}
        </div>

        <div className="absolute inset-x-9 bottom-9">
          <div className="cmc-label mb-3">{copy.muralKicker}</div>
          <h1
            className="cmc-display mb-3.5 max-w-[480px] text-[36px] font-bold leading-[1.1]"
            style={{ letterSpacing: "-0.018em" }}
          >
            {headlineL1}
            {headlineL2 ? (
              <>
                <br />
                {headlineL2}
              </>
            ) : null}
          </h1>
          <p
            className="max-w-[460px] text-[12.5px] leading-relaxed"
            style={{ color: "var(--c-fg-3)" }}
          >
            {copy.muralSubcopy}
          </p>
          <div
            className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px]"
            style={{ color: "var(--c-fg-4)" }}
          >
            {copy.buildLabel ? (
              <>
                <span>{copy.buildLabel}</span>
                <span>·</span>
              </>
            ) : null}
            <span>{copy.dataCenter}</span>
            {copy.complianceLine ? (
              <>
                <span>·</span>
                <span>{copy.complianceLine}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Right form */}
      <div
        className="flex w-full flex-col px-12 py-16 lg:w-[440px] lg:border-l"
        style={{ borderColor: "var(--c-line-2)" }}
      >
        <div className="cmc-label mb-1.5">{t("secure")}</div>
        <h2
          className="cmc-display mb-8 text-[26px] font-semibold"
          style={{ letterSpacing: "-0.015em" }}
        >
          {t("welcomeBack")}
        </h2>

        <Suspense fallback={<LoginFormSkeleton />}>
          <LoginForm />
        </Suspense>

        <div className="flex-1" />
        <p
          className="mt-5 text-[10px] leading-relaxed"
          style={{ color: "var(--c-fg-4)" }}
        >
          {t("aup")}
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

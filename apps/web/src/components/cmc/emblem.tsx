export function Emblem({ size = 26 }: { size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: 7,
        background: "linear-gradient(160deg, #1a2030, #0a0e14)",
        border: "0.5px solid var(--c-line-3)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 2px rgba(0,0,0,0.5)",
      }}
      aria-hidden
    >
      <svg
        width={size * 0.65}
        height={size * 0.65}
        viewBox="0 0 20 20"
      >
        <path
          d="M2 16L7 7l3 5 2-3 6 7z"
          fill="var(--c-accent)"
          opacity="0.85"
        />
        <circle cx="14" cy="5" r="1.6" fill="#f5d142" />
        <path d="M2 17h16" stroke="var(--c-fg-3)" strokeWidth="0.6" />
      </svg>
    </div>
  );
}

/**
 * Simple HTML email templates (P1.6c / ADR-0024). Template-literal HTML with
 * inline styles (email clients ignore <style>/external CSS) — no MJML toolchain
 * for now. Every interpolation is HTML-escaped.
 */

export type RenderedEmail = { subject: string; html: string; text: string };

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function button(href: string, label: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;background:#2f6fed;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:13px">${esc(label)}</a>`;
}

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a2e">
  <div style="max-width:480px;margin:0 auto;padding:24px">
    <div style="background:#ffffff;border-radius:10px;border:1px solid #e6e8eb;overflow:hidden">
      <div style="padding:16px 22px;border-bottom:1px solid #eef0f2;font-weight:600;font-size:15px">${esc(title)}</div>
      <div style="padding:22px;font-size:13.5px;line-height:1.6">${bodyHtml}</div>
    </div>
    <div style="text-align:center;color:#9aa0a6;font-size:11px;margin-top:14px">Crisis Management Center</div>
  </div></body></html>`;
}

export function buildResetEmail(p: {
  name: string;
  resetUrl: string;
  expiresAt: string;
}): RenderedEmail {
  const subject = "Reset your CMC password";
  const html = layout(
    subject,
    `<p>Hi ${esc(p.name)},</p>
     <p>A password reset was requested for your account. Use the button below to set a new password. This link expires at ${esc(p.expiresAt)}.</p>
     <p style="margin:18px 0">${button(p.resetUrl, "Reset password")}</p>
     <p style="color:#9aa0a6;font-size:12px">If you didn't request this, you can safely ignore this email.</p>`,
  );
  const text = `Reset your CMC password

Hi ${p.name},
A password reset was requested for your account. Open this link to set a new password (expires ${p.expiresAt}):
${p.resetUrl}

If you didn't request this, ignore this email.`;
  return { subject, html, text };
}

export function buildNotificationEmail(p: {
  title: string;
  body?: string | null;
  url?: string | null;
}): RenderedEmail {
  const subject = p.title;
  const html = layout(
    p.title,
    `${p.body ? `<p>${esc(p.body)}</p>` : ""}
     ${p.url ? `<p style="margin:18px 0">${button(p.url, "Open in CMC")}</p>` : ""}`,
  );
  const text = `${p.title}${p.body ? `\n${p.body}` : ""}${p.url ? `\n\n${p.url}` : ""}`;
  return { subject, html, text };
}

import { expect, test } from "@playwright/test";
import {
  createTenantWithUser,
  ownerSql,
  truncateAll,
  type TestUser,
} from "./utils/test-data";

let user: TestUser;

test.beforeEach(async () => {
  const sql = ownerSql();
  try {
    await truncateAll(sql);
    const fixture = await createTenantWithUser(sql, {
      tenantSlug: "pw-auth",
      email: "alice@playwright.test",
      password: "alice_playwright_pwd",
    });
    user = fixture.user;
  } finally {
    await sql.end({ timeout: 2 });
  }
});

test("anonymous /dashboard is redirected to /login with next=", async ({
  page,
}) => {
  const response = await page.goto("/dashboard");
  // The middleware issues a 307 → /login?next=/dashboard. Playwright
  // follows the redirect and lands on /login.
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
});

test("anonymous / redirects to /login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login(\?|$)/);
});

test("login happy path lands on /dashboard with the user's email visible", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/dashboard$/);
  // Tenant slug renders in the page header — not just inside the JSON
  // dump that the body also shows. Targeting the <code> element keeps
  // the assertion specific.
  await expect(
    page.locator("header code", { hasText: "pw-auth" }),
  ).toBeVisible();
  // /auth/me succeeded — the rendered JSON contains the user's email,
  // and the failure banner is hidden.
  await expect(page.locator("pre", { hasText: user.email })).toBeVisible();
  await expect(page.getByText(/API call failed/i)).toBeHidden();
});

test("login with wrong password keeps the user on /login and shows an error", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill("totally-wrong-password");
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("sign-out drops the session and bounces back to /login", async ({
  page,
}) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(page).toHaveURL(/\/login/);

  // Confirm the cookie was actually cleared: a direct nav to /dashboard
  // should redirect again.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login\?next=%2Fdashboard/);
});

test("middleware redirects logged-in users away from /login to /dashboard", async ({
  page,
}) => {
  // Sign in.
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  // Hitting /login while authenticated bounces to /dashboard.
  await page.goto("/login");
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("login flow respects the `next` query param after redirect", async ({
  page,
}) => {
  // Try to hit a protected page anonymously.
  await page.goto("/documents");
  await expect(page).toHaveURL(/\/login\?next=%2Fdocuments/);

  // Sign in and verify we land at /documents, not /dashboard.
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/documents$/);
});

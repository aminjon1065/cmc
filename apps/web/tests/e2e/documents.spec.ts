import { expect, test } from "@playwright/test";
import {
  createTenantWithUser,
  ownerSql,
  truncateAll,
  type TestUser,
} from "./utils/test-data";

let user: TestUser;

test.beforeEach(async ({ page }) => {
  const sql = ownerSql();
  try {
    await truncateAll(sql);
    const fixture = await createTenantWithUser(sql, {
      tenantSlug: "pw-docs",
      email: "doc-owner@playwright.test",
      password: "doc_owner_pw_8x",
    });
    user = fixture.user;
  } finally {
    await sql.end({ timeout: 2 });
  }

  // Sign in for every test.
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test("dashboard links to Documents", async ({ page }) => {
  await page.getByRole("link", { name: /documents/i }).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(page.getByRole("heading", { name: /files in/i })).toBeVisible();
});

test("documents page starts empty", async ({ page }) => {
  await page.goto("/documents");
  await expect(page.getByText(/no documents yet/i)).toBeVisible();
});

test("upload lifecycle: file → presigned PUT to MinIO → finalize → row appears", async ({
  page,
}) => {
  await page.goto("/documents");

  // The upload form's button is a styled <label> wrapping a hidden file
  // input — `getByRole('button')` won't match. Drive the input directly.
  await page.locator('input[type="file"]').setInputFiles({
    name: "playwright-report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Hello from Playwright!"),
  });

  // The row appears after init → PUT → finalize → revalidatePath.
  const row = page.getByRole("row", { name: /playwright-report\.txt/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText("text/plain")).toBeVisible();
  await expect(page.getByText(/^1 document$/)).toBeVisible();
});

test("delete removes the row and updates the count", async ({ page }) => {
  // Stub `confirm()` to always return true. Auto-accepting via the
  // `dialog` event flaked here — overriding the function before the
  // page loads is bullet-proof and standard Playwright practice.
  await page.addInitScript(() => {
    window.confirm = () => true;
  });
  await page.goto("/documents");

  await page.locator('input[type="file"]').setInputFiles({
    name: "to-delete.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("bye"),
  });
  await expect(page.getByRole("row", { name: /to-delete\.txt/ })).toBeVisible({
    timeout: 15_000,
  });

  await page
    .getByRole("row", { name: /to-delete\.txt/ })
    .getByRole("button", { name: /delete/i })
    .click();

  await expect(page.getByText(/no documents yet/i)).toBeVisible({
    timeout: 10_000,
  });
});

// NOTE: a Playwright test that drives the Download button into a popup
// flakes — MinIO responds with `Content-Disposition: attachment`, which
// chromium treats as a download (no document loads in the popup). The
// download URL contract is already covered by the api e2e tests, and the
// upload-lifecycle test above asserts the bytes reach MinIO. Re-add a
// browser-side download verification when we ship a true preview UI.

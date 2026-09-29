import { expect, test } from '@playwright/test';
import { readToken } from '../helpers/env.js';

test.describe('auth flow', () => {
  test('redirects to /login when no cookie is set', async ({ page }) => {
    await page.goto('/ui/');
    await expect(page).toHaveURL(/\/ui\/login$/);
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test('signs in with the daemon-issued token and lands on Live', async ({ page }) => {
    const token = readToken();
    await page.goto('/ui/login');
    await page.fill('input[type="password"]', token);
    await page.click('button[type="submit"]');
    // The login page does a hard reload after the POST succeeds.
    await page.waitForURL(/\/ui\/live$/);
    await expect(page.getByTestId('observation-list')).toBeVisible();
  });

  test('rejects an invalid token with a visible error', async ({ page }) => {
    await page.goto('/ui/login');
    await page.fill('input[type="password"]', 'not-the-token');
    await page.click('button[type="submit"]');
    await expect(page.locator('.error')).toContainText(/rejected|HTTP/);
  });
});

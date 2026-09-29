import { expect, test } from '@playwright/test';
import { readToken } from '../helpers/env.js';

let token = '';

test.beforeAll(() => {
  token = readToken();
});

/**
 * Smoke spec for the /ui/individuals route — verifies the UI surface
 * renders + navigation + form validation without depending on a
 * real DINOv2 backbone.
 *
 * The full upload-to-detect roundtrip (operator drops photos → next
 * observation tagged with the individual within 5 s) is gated on the
 * maintainer's pre-cutover weight-pin step
 * (`framescout models fetch dinov2-small --pin`). It lands as a
 * follow-up Playwright spec once weights are pinned + reference
 * photos for a fixture cat are committed.
 *
 * The fixture config in tests/e2e/fixtures/config.yaml does NOT
 * declare an @framescout/detector-individual-embed detector, so the
 * `/api/individuals/*` routes aren't registered — the UI's API
 * calls 404. This spec asserts the UI handles that gracefully (the
 * route still renders, the toolbar / nav still work) so a partial
 * deployment never produces a broken-looking page.
 */
test.describe('Operator UI — Individuals route', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui/login');
    await page.fill('input[type="password"]', token);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/ui\/live$/);
  });

  test('navigating to /ui/individuals renders the route shell', async ({ page }) => {
    await page.goto('/ui/individuals');
    // The route header is always present, regardless of whether the
    // backend has the detector wired.
    await expect(page.getByRole('heading', { name: 'Individuals' })).toBeVisible();
    // The toolbar's "Add individual" button is always present.
    await expect(page.getByRole('link', { name: '+ Add individual' })).toBeVisible();
  });

  test('the sidebar nav surfaces an "Individuals" entry', async ({ page }) => {
    await page.goto('/ui/live');
    await expect(page.getByRole('link', { name: 'Individuals' })).toBeVisible();
    await page.getByRole('link', { name: 'Individuals' }).click();
    await page.waitForURL(/\/ui\/individuals/);
    await expect(page.getByRole('heading', { name: 'Individuals' })).toBeVisible();
  });

  test('the create-individual form enforces name validation', async ({ page }) => {
    await page.goto('/ui/individuals/new');
    const nameInput = page.getByTestId('individual-name-input');
    await expect(nameInput).toBeVisible();
    // HTML5 pattern validation: uppercase rejected.
    await nameInput.fill('Tulli');
    await page.getByRole('button', { name: /create/i }).click();
    // Browser-native validation message visibility check — the form
    // must NOT navigate when invalid. URL stays put.
    await expect(page).toHaveURL(/\/ui\/individuals\/new/);
  });

  test('Cancel link returns to the list view', async ({ page }) => {
    await page.goto('/ui/individuals/new');
    await page.getByRole('link', { name: 'Cancel' }).click();
    await page.waitForURL(/\/ui\/individuals$/);
    await expect(page.getByRole('heading', { name: 'Individuals' })).toBeVisible();
  });
});

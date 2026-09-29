import { expect, test } from '@playwright/test';
import { readToken } from '../helpers/env.js';

let token = '';

test.beforeAll(() => {
  token = readToken();
});

/**
 * Smoke spec for the training-dataset labelling UI — the /ui/dataset
 * overview, the sidebar nav entry, and the per-observation "Label for
 * training" affordance on the Live feed.
 *
 * The /api/dataset/* routes are always registered (the service is
 * backed by the observation ring), so the stats endpoint works on an
 * empty dataset (total 0). A *successful* label POST needs an
 * observation whose bestFrame JPEG was retained; the stub source emits
 * frameless synthetic observations, so the success path is covered by
 * the core unit tests (dataset-service.test.ts) rather than here. This
 * spec asserts the UI affordances render and open.
 */
test.describe('Operator UI — Dataset route', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui/login');
    await page.fill('input[type="password"]', token);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/ui\/live$/);
  });

  test('navigating to /ui/dataset renders stats', async ({ page }) => {
    await page.goto('/ui/dataset');
    await expect(page.getByRole('heading', { name: 'Dataset' })).toBeVisible();
    await expect(page.getByTestId('dataset-total')).toBeVisible();
  });

  test('the sidebar nav surfaces a "Dataset" entry', async ({ page }) => {
    await page.goto('/ui/live');
    await page.getByRole('link', { name: 'Dataset' }).click();
    await page.waitForURL(/\/ui\/dataset/);
    await expect(page.getByRole('heading', { name: 'Dataset' })).toBeVisible();
  });

  test('a Live observation card exposes a label form', async ({ page }) => {
    await page.goto('/ui/live');
    const toggle = page.getByTestId('label-toggle').first();
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.getByTestId('label-species-input').first()).toBeVisible();
  });
});

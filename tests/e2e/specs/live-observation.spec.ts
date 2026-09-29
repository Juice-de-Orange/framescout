import { expect, test } from '@playwright/test';
import { readToken } from '../helpers/env.js';

let token = '';

test.beforeAll(() => {
  token = readToken();
});

/**
 * Asserts the Live route lists observations pushed into the daemon's
 * ObservationRing. The fixture config wires the `@framescout-e2e/
 * source-stub` plugin that emits 5 synthetic CaptureEvents at boot,
 * with `emitBlankObservations: true` so the pipeline produces a
 * `blank` Observation per event.
 */
test.describe('live observation feed', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui/login');
    await page.fill('input[type="password"]', token);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/ui\/live$/);
  });

  test('renders observation cards as the stub source emits events', async ({ page }) => {
    const list = page.getByTestId('observation-list');
    await expect(list).toBeVisible();
    // The stub emits 5 events over ~2 s; assert at least 3 land in the UI.
    await expect
      .poll(
        async () => await list.locator('li.observation').count(),
        { timeout: 15_000, intervals: [200, 500, 1000] },
      )
      .toBeGreaterThanOrEqual(3);
  });
});

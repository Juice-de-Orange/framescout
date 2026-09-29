import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_DATA_DIR, readToken } from '../helpers/env.js';

async function loginWithToken(page: import('@playwright/test').Page, token: string): Promise<void> {
  await page.goto('/ui/login');
  await page.fill('input[type="password"]', token);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/ui\/live$/);
}

/**
 * Save & Restart round-trip — validate → stage → apply → SIGTERM
 * → supervised respawn. We verify:
 *
 *   (1) the staged YAML lands on disk after apply (file content has
 *       the new value), and
 *   (2) the daemon does come back up (/healthz responds 200) after
 *       the supervisor respawns it.
 *
 * We intentionally do NOT poll /api/config across the restart to
 * inspect resolved-readonly — that's two flaky moving pieces (cookie
 * re-mint + brief 9091 unbind window). Disk content + healthz are the
 * actual observable acceptance criteria.
 */
test.describe('config apply + restart', () => {
  test('save & restart rewrites config.yaml on disk and the daemon comes back up', async ({
    page,
    request: standaloneRequest,
  }) => {
    const token = readToken();
    await loginWithToken(page, token);
    // page.request inherits the page's cookie jar — the standalone
    // `request` fixture is a separate context and never sees the
    // session cookie set by `loginWithToken`, so it would 401 on
    // protected routes.
    const request = page.request;
    // Explicit Origin — Playwright's APIRequest doesn't auto-add it
    // and the daemon's CSRF guard rejects state-changing methods
    // without a matching Origin.
    const csrfHeaders = { Origin: 'http://127.0.0.1:9091' };

    const before = await request.get('/api/config');
    expect(before.status()).toBe(200);
    const { yamlText: originalYaml } = (await before.json()) as { yamlText: string };

    // Inject crashBudget INTO the existing framescout: block. Naive
    // append would produce two `framescout:` keys → "Map keys must
    // be unique" from the YAML parser. The fixture's metricsPort
    // line carries an inline comment, so the regex matches the
    // whole line up to (and including) its trailing newline.
    const tweakedMax = 11;
    const tweakedYaml = originalYaml.replace(
      /(^[ \t]*metricsPort:[^\n]*\n)/m,
      `$1  crashBudget:\n    maxFailures: ${tweakedMax}\n`,
    );
    expect(tweakedYaml).toContain(`maxFailures: ${tweakedMax}`);

    const putRes = await request.put('/api/config', {
      headers: csrfHeaders,
      data: { yamlText: tweakedYaml },
    });
    expect(putRes.status()).toBe(200);
    const applyRes = await request.post('/api/config/apply', { headers: csrfHeaders });
    expect(applyRes.status()).toBe(200);

    // (1) Disk content reflects the staged change. apply() moves
    // pending → committed before signalling restart, so this should
    // be visible immediately after the 200.
    const configPath = join(E2E_DATA_DIR, 'config.yaml');
    await expect
      .poll(
        async () => {
          try {
            const text = await readFile(configPath, 'utf-8');
            return text.includes(`maxFailures: ${tweakedMax}`);
          } catch {
            return false;
          }
        },
        { timeout: 5_000, intervals: [100, 200, 500] },
      )
      .toBe(true);

    // (2) Supervisor respawns the daemon. The /api/config/apply
    // handler uses a setTimeout(50ms) before SIGTERM-self so the
    // response can flush — meaning the OLD daemon is still answering
    // /healthz briefly after we get here. Poll the full cycle
    // (up → down → up) so we don't leave the next spec racing
    // against a daemon that's about to be SIGTERM'd.
    await expect
      .poll(
        async () => {
          try {
            const r = await standaloneRequest.get('/healthz');
            return r.status() === 200 ? 'old-up' : 'other';
          } catch {
            return 'down';
          }
        },
        { timeout: 10_000, intervals: [50, 100, 200] },
      )
      .toBe('down');
    await expect
      .poll(
        async () => {
          try {
            const r = await standaloneRequest.get('/healthz');
            return r.status();
          } catch {
            return 0;
          }
        },
        { timeout: 20_000, intervals: [200, 500, 1000] },
      )
      .toBe(200);
  });
});

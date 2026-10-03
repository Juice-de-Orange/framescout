import { expect, test } from '@playwright/test';
import { readToken } from '../helpers/env.js';

let token = '';

test.beforeAll(() => {
  token = readToken();
});

test.describe('config validate flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/ui/login');
    await page.fill('input[type="password"]', token);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/ui\/live$/);
  });

  test('Validate button reports "valid" for the loaded config', async ({ page }) => {
    await page.goto('/ui/config');
    await expect(page.getByTestId('yaml-editor')).toBeVisible();
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.locator('.status')).toContainText('valid');
    await expect(page.getByTestId('issues')).toHaveCount(0);
  });

  test('editor shows the config even when Monaco loads after it', async ({ page }) => {
    // Force the race: hold back the Monaco chunk so /api/config answers
    // first. The editor used to be created with the value of the very first
    // render (empty) and never received the config that arrived meanwhile.
    await page.route(/\/ui\/assets\/editor\.main-.*\.js$/, async (route) => {
      await new Promise((r) => setTimeout(r, 3_000));
      await route.continue();
    });
    await page.goto('/ui/config');
    await page.locator('.monaco-editor').waitFor({ state: 'attached', timeout: 20_000 });
    await expect
      .poll(
        () =>
          page
            .getByTestId('yaml-editor')
            .evaluate((el) =>
              el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? ''),
            ),
        { timeout: 10_000 },
      )
      .toContain('framescout:');
  });

  test('Validate flags a malformed edit', async ({ page }) => {
    await page.goto('/ui/config');
    const editor = page.getByTestId('yaml-editor');
    // `yaml-editor` is NOT always a <textarea>: MonacoYamlEditor first renders
    // a fallback textarea and hands the testid on to Monaco's <div> once the
    // bundle has loaded. `inputValue()` then fails with "Node is not an
    // <input>" — so read the value independently of the element type.
    const editorValue = async (): Promise<string> =>
      editor.evaluate((el) =>
        el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? ''),
      );

    // ConfigRoute loads the YAML in a useEffect; if we fill before
    // that resolves, the late `setYamlText(loaded)` clobbers our
    // edit and the test ends up validating either an empty editor
    // or a hybrid. Wait for the loaded content before overwriting.
    await expect
      .poll(async () => (await editorValue()).length, {
        timeout: 10_000,
        intervals: [100, 200, 500],
      })
      .toBeGreaterThan(0);

    // Neither `fill()` nor `keyboard.type()`: Monaco is not a form field, and
    // typing character by character ran into a 30 s timeout. Monaco listens on
    // a hidden `textarea.inputarea` that accepts `insertText` in one go. If it
    // is missing (fallback textarea because the bundle did not load), write
    // straight into the textarea.
    const YAML = 'framescout:\n  metricsPort: "nope"\n';
    // MonacoYamlEditor first shows a fallback textarea and replaces it with
    // Monaco's <div> once the bundle has loaded. Any "what is the element right
    // now?" check is therefore a race: in CI it was still a textarea during the
    // type check and already a <div> at `fill()` (never reproducible locally,
    // where Monaco finished faster). So don't ask — wait, and fall back to the
    // textarea only when Monaco really does not arrive.
    // Monaco's input element: a hidden `textarea.inputarea` up to 0.52; from 0.53 on, Chromium
    // gets the EditContext-based `div.native-edit-context` instead. Accept either.
    const monacoInput = page
      .locator('.monaco-editor textarea.inputarea, .monaco-editor .native-edit-context')
      .first();
    const monacoReady = await monacoInput
      .waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (monacoReady) {
      await monacoInput.focus();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.insertText(YAML);
    } else {
      await editor.fill(YAML);
    }
    // The editor must really hold the new text — otherwise the click below
    // validates the old content and the test passes without proving anything.
    await expect.poll(() => editorValue(), { timeout: 5_000 }).toContain('nope');
    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByTestId('issues')).toBeVisible();
    await expect(page.getByTestId('issues')).toContainText(/metricsPort/);
  });
});

// The full Save & Restart round-trip (validate → stage → apply →
// SIGTERM → respawn → reload) is covered by
// `config-apply-restart.spec.ts` against the supervised-daemon
// wrapper.

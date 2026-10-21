// Capture the real static UI with deterministic, local-only sample data.
// Run from any directory with: npm run docs:screenshots
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/previews');
const sampleConfig = {
  api_key: 'preview-key-not-a-real-credential',
  base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', vision_model: '',
  target_language: 'Vietnamese', custom_prompt: '',
  hotkeys: {
    translate: { prefix: 'Ctrl+C', then: 'C', window_ms: 600 },
    chat: { prefix: 'Ctrl+C', then: 'Space', window_ms: 600 },
    screenshot: { prefix: 'RCtrl', then: 'RCtrl', window_ms: 400 },
  },
};
const selectedText = 'Three independent tasks, each taking 2 seconds.';
const chatReply = [
  '### One wait instead of three',
  'Independent tasks can run **at the same time**. Wait for all of them with `Promise.all`.', '',
  '| Approach | Total time |', '| :--- | ---: |',
  '| One after another | 6 seconds |', '| All three together | 2 seconds |', '',
  '```javascript', 'const results = await Promise.all([',
  '  loadProfile(), loadOrders(), loadStats()', ']);', '```', '',
  '> Use this when no task needs another task’s result.',
].join('\n');
const richReply = [
  '### Same work, less waiting',
  'With equal task durations and no extra overhead:', '',
  '$$\\text{Speedup} = \\frac{6\\,\\text{s}}{2\\,\\text{s}} = 3\\times$$', '',
  '```mermaid', 'flowchart TD',
  'S[Start] --> A((A))', 'S --> B((B))', 'S --> C((C))',
  'A --> R[Ready]', 'B --> R', 'C --> R', '```', '',
  '- [x] Start independent tasks together', '- [x] Wait until every task completes',
].join('\n');
const original = [
  '### Choose a workflow', 'Select text and use the right **shortcut**.', '',
  '| Action | Use it to |', '| --- | --- |',
  '| Translate | Read selected text |', '| Chat | Ask follow-up questions |', '',
  'Keep your context when switching from reading to questions.',
].join('\n');
const translation = [
  '### Chọn cách làm việc',
  'Chọn văn bản rồi dùng **phím tắt** phù hợp.', '',
  '| Thao tác | Mục đích |', '| --- | --- |',
  '| Dịch | Đọc văn bản đã chọn |', '| Trò chuyện | Đặt câu hỏi tiếp theo |', '',
  'Giữ nguyên ngữ cảnh khi chuyển từ đọc sang hỏi đáp.',
].join('\n');

async function installPreviewBridge(page, theme) {
  await page.addInitScript(config => {
    const handlers = new Map();
    window.__preview = {
      ready: false,
      fire(name, payload = '') {
        const callbacks = handlers.get(name);
        if (!callbacks?.size) throw new Error(`No preview listener for ${name}`);
        for (const callback of callbacks) callback({ payload });
      },
    };
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        switch (command) {
          case 'get_config': return structuredClone(config);
          case 'update_config': Object.assign(config, args.update); return null;
          case 'take_pending_chat_selection':
          case 'take_pending_image':
          case 'resize_translate_popup': return null;
          case 'chat_send': return new Promise(resolve => { window.__preview.complete = resolve; });
          default: throw new Error(`Unexpected preview command: ${command}`);
        }
      } },
      event: {
        listen: async (name, callback) => {
          if (!handlers.has(name)) handlers.set(name, new Set());
          handlers.get(name).add(callback);
          return () => handlers.get(name).delete(callback);
        },
        emit: async name => { if (name === 'popup://ready') window.__preview.ready = true; },
      },
      window: { getCurrentWindow: () => ({
        close: async () => {}, onFocusChanged: async () => {}, isFocused: async () => true,
      }) },
    };
  }, { ...sampleConfig, theme });
}

function frontendUrl(name, params = {}) {
  const url = pathToFileURL(path.join(root, 'frontend', name));
  url.search = new URLSearchParams(params).toString();
  return url.href;
}

async function stream(page, flow, text) {
  // Exercise the application's stream listeners and final render, rather than
  // injecting HTML or replacing any production styles for the screenshots.
  const split = text.indexOf('\n\n') + 1;
  for (const chunk of [text.slice(0, split), text.slice(split)]) {
    await page.evaluate(({ flow, chunk }) => window.__preview.fire(`${flow}://chunk`, chunk), { flow, chunk });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  await page.evaluate(flow => {
    window.__preview.fire(`${flow}://done`);
    window.__preview.complete?.();
  }, flow);
}

async function capture(page, name, errors) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].filter(image => image.hasAttribute('src')).map(image => image.decode()));
    document.activeElement?.blur();
  });
  await page.mouse.move(0, 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(errors, [], `${name} has browser errors`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflows horizontally`);
  for (const content of await page.locator('#transcript, #result-area').all()) {
    assert.ok(await content.evaluate(node => node.scrollHeight <= node.clientHeight + 1), `${name} clips the sample response`);
  }
  await page.screenshot({ path: path.join(output, name + '.png'), omitBackground: true, animations: 'disabled', caret: 'hide' });
  console.log(`Captured ${name}.png`);
}

await mkdir(output, { recursive: true });
const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {});
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme: theme, deviceScaleFactor: 2, reducedMotion: 'reduce', locale: 'en-US' });
    // Every screenshot is offline; provider URLs in settings are display-only.
    await context.route(/^https?:\/\//, route => route.abort('blockedbyclient'));
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('requestfailed', request => errors.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`));
      await installPreviewBridge(page, theme);

      await page.setViewportSize({ width: 520, height: 720 });
      await page.goto(frontendUrl('chat.html', { selected: selectedText }));
      await expect(page.locator('#chat-input')).toBeFocused();
      await page.locator('#chat-input').fill('Compare the approaches and show the code.');
      await page.locator('#send-btn').click();
      await stream(page, 'chat', chatReply);
      await expect(page.locator('.msg-ai table')).toBeVisible();
      await expect(page.locator('.msg-ai .hljs-keyword').first()).toBeVisible();
      await expect(page.locator('.msg-ai blockquote')).toBeInViewport();
      await expect(page.locator('#chat-input')).toBeInViewport();
      await capture(page, `chat-${theme}`, errors);

      await page.setViewportSize({ width: 520, height: 800 });
      await page.goto(frontendUrl('chat.html', { selected: selectedText }));
      await expect(page.locator('#chat-input')).toBeFocused();
      await page.locator('#chat-input').fill('Show the speedup and draw the task flow.');
      await page.locator('#send-btn').click();
      await stream(page, 'chat', richReply);
      await expect(page.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'ready');
      await expect(page.locator('.katex')).toBeVisible();
      await expect(page.locator('.task-list-item').last()).toBeInViewport();
      const diagramSize = await page.locator('.diagram-preview').evaluate(node => ({ content: node.scrollWidth, viewport: node.clientWidth }));
      assert.ok(diagramSize.content <= diagramSize.viewport, `Diagram must be fully visible: ${JSON.stringify(diagramSize)}`);
      await capture(page, `rich-content-${theme}`, errors);

      await page.setViewportSize({ width: 500, height: 440 });
      await page.goto(frontendUrl('popup.html', { original, lang: 'Vietnamese' }));
      await page.waitForFunction(() => window.__preview.ready);
      await stream(page, 'translate', translation);
      await expect(page.locator('#translation-text table')).toBeVisible();
      await expect(page.locator('#translation-text p').last()).toBeInViewport();
      await expect(page.locator('#copy-btn')).toBeEnabled();
      await capture(page, `popup-${theme}`, errors);

      await page.setViewportSize({ width: 600, height: 680 });
      await page.goto(frontendUrl('settings.html'));
      await expect(page.locator('#save-btn')).toBeEnabled();
      await expect(page.locator('#model')).toHaveValue(sampleConfig.model);
      await capture(page, `settings-${theme}`, errors);
      await page.locator('a[href="#appearance"]').click();
      await expect(page.locator('#theme')).toBeInViewport();
      await expect(page.locator('#theme')).toHaveValue(theme);
      await capture(page, `appearance-${theme}`, errors);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

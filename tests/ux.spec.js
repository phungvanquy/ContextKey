const { test, expect } = require('@playwright/test');

const defaults = {
  api_key: 'test-key', base_url: 'https://example.invalid/v1', model: 'test-model',
  vision_model: '', target_language: 'Vietnamese', custom_prompt: '',
  hotkeys: {
    translate: { prefix: 'Ctrl+C', then: 'C', window_ms: 800 },
    chat: { prefix: 'Ctrl+C', then: 'Space', window_ms: 600 },
    screenshot: { prefix: 'RCtrl', then: 'RCtrl', window_ms: 400 },
  },
};

async function bridge(page, overrides = {}) {
  await page.addInitScript(({ config, overrides }) => {
    const handlers = new Map();
    window.__mock = { calls: [], closed: false, pendingSelection: null, pendingImage: null, ...overrides };
    const savedConfig = sessionStorage.getItem('mock-saved-config');
    if (savedConfig) window.__mock.config = JSON.parse(savedConfig);
    window.__fire = (event, payload) => {
      for (const callback of handlers.get(event) || []) callback({ payload });
    };
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        const mock = window.__mock;
        mock.calls.push({ command, args: args ? structuredClone(args) : null });
        if (command === 'get_config') {
          if (mock.loadError) throw new Error('Unable to read settings');
          return { ...config, ...mock.config };
        }
        if (command === 'update_config') {
          if (mock.saveError) throw new Error('Unable to save settings');
          mock.config = { ...config, ...mock.config, ...args.update };
          sessionStorage.setItem('mock-saved-config', JSON.stringify(mock.config));
          return null;
        }
        if (command === 'take_pending_chat_selection') {
          const value = mock.pendingSelection; mock.pendingSelection = null; return value;
        }
        if (command === 'take_pending_image') {
          const value = mock.pendingImage; mock.pendingImage = null; return value;
        }
        if (command === 'chat_send') {
          if (mock.sendError) throw new Error('Request could not start');
          return new Promise(resolve => { mock.resolveChat = resolve; });
        }
        if (command === 'open_external_url' && mock.openLinkError) throw new Error('Browser unavailable');
        if (command === 'test_connection') {
          if (mock.testPending) return new Promise(resolve => { mock.resolveTest = resolve; });
          if (mock.testError) throw new Error('HTTP 401 Unauthorized');
          return 'OK';
        }
        return null;
      } },
      event: {
        listen: async (event, callback) => {
          const callbacks = handlers.get(event) || []; callbacks.push(callback); handlers.set(event, callbacks);
          return () => {};
        },
        emit: async event => { window.__mock.calls.push({ command: event }); },
      },
      window: { getCurrentWindow: () => ({
        close: async () => { window.__mock.closed = true; },
        onFocusChanged: async () => {}, isFocused: async () => true,
      }) },
    };
    window.__screenshot = label => {
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 450;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 800, 450);
      ctx.fillStyle = '#222222'; ctx.font = '32px sans-serif'; ctx.fillText(label, 24, 60);
      return canvas.toDataURL('image/png');
    };
  }, { config: defaults, overrides });
}

async function openChat(page, selected = 'Selected source text.', overrides) {
  await bridge(page, overrides);
  await page.goto('/chat.html?selected=' + encodeURIComponent(selected));
  await expect(page.locator('#chat-input')).toBeFocused();
}
async function openSettings(page, overrides) {
  await bridge(page, overrides);
  await page.setViewportSize({ width: 520, height: 520 });
  await page.goto('/settings.html');
  await expect(page.locator('#save-btn')).toBeEnabled();
}
async function send(page, text) {
  await page.locator('#chat-input').fill(text);
  await page.locator('#send-btn').click();
}
async function complete(page, text = 'A complete response.') {
  await page.evaluate(text => {
    window.__fire('chat://chunk', text); window.__fire('chat://done', ''); window.__mock.resolveChat?.();
  }, text);
}
async function fail(page) {
  await page.evaluate(() => {
    window.__fire('chat://error', { summary: 'Connection lost.', detail: 'Simulated network error', retryable: true });
    window.__fire('chat://done', ''); window.__mock.resolveChat?.();
  });
}
async function attach(page, label) {
  await page.evaluate(label => {
    window.__mock.pendingImage = window.__screenshot(label);
    window.__fire('chat://image-available', '');
  }, label);
  await expect(page.locator('#image-strip')).toBeVisible();
}
async function requests(page, command = 'chat_send') {
  return page.evaluate(command => window.__mock.calls.filter(call => call.command === command).map(call => call.args), command);
}

async function openStreamingOutput(page, flow) {
  if (flow === 'chat') {
    await openChat(page);
    await send(page, 'Show formatted text');
    return page.locator('.msg-ai');
  }
  await bridge(page);
  await page.goto('/popup.html?original=Source');
  await expect.poll(() => requests(page, 'popup://ready')).toHaveLength(1);
  return page.locator('#translation-text');
}

async function streamEvent(page, flow, type, payload = '') {
  await page.evaluate(({ flow, type, payload }) => {
    window.__fire(`${flow}://${type}`, payload);
    if (type === 'done') window.__mock.resolveChat?.();
  }, { flow, type, payload });
}

for (const flow of ['chat', 'translate']) {
  test(`${flow} renders Markdown before completion across split chunks`, async ({ page }) => {
    const output = await openStreamingOutput(page, flow);
    const chunks = [
      '# Live heading\n\nA **bo',
      'ld** with *italic*, ***both*** and `code`.\n\n- first\n- sec',
      'ond\n\n1. ordered\n2. next\n\n```js\nconst value = "<tag>";\n',
      'console.log(value);\n```\n\nFinished.',
    ];
    await streamEvent(page, flow, 'chunk', chunks[0]);
    await expect(output.locator('h1')).toHaveText('Live heading');
    await expect(output.locator('p')).toHaveText('A **bo');
    await expect(output.locator('strong')).toHaveCount(0);
    await streamEvent(page, flow, 'chunk', chunks[1]);
    await expect(output.locator('strong')).toHaveText(['bold', 'both']);
    await expect(output.locator('em')).toHaveText(['italic', 'both']);
    await expect(output.locator('code')).toHaveText('code');
    await expect(output.locator('ul li')).toHaveText(['first', 'sec']);
    await streamEvent(page, flow, 'chunk', chunks[2]);
    await expect(output.locator('ul li')).toHaveText(['first', 'second']);
    await expect(output.locator('ol li')).toHaveText(['ordered', 'next']);
    await expect(output.locator('pre code')).toHaveText('const value = "<tag>";\n');
    await streamEvent(page, flow, 'chunk', chunks[3]);
    await expect(output.locator('pre code')).toHaveText('const value = "<tag>";\nconsole.log(value);');
    await expect(output.locator('p').last()).toHaveText('Finished.');
    await expect(output).toHaveCSS('white-space', 'normal');
    await expect(page.locator(flow === 'chat' ? '#send-btn' : '#copy-btn')).toBeDisabled();
    const streamedHtml = await output.innerHTML();
    await streamEvent(page, flow, 'done');
    expect(await output.innerHTML()).toBe(streamedHtml);

    // Formatting must never replace the raw source used for history or Copy.
    if (flow === 'chat') {
      await send(page, 'Follow-up');
      expect((await requests(page)).at(-1).history[1].content).toBe(chunks.join(''));
    } else {
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async text => { window.__mock.copiedText = text; } },
        configurable: true,
      }));
      await page.locator('#copy-btn').click();
      expect(await page.evaluate(() => window.__mock.copiedText)).toBe(chunks.join(''));
      await expect.poll(() => requests(page, 'resize_translate_popup')).not.toHaveLength(0);
    }
  });

  test(`${flow} keeps HTML inert while streaming and flushes the last chunk on completion`, async ({ page }) => {
    const output = await openStreamingOutput(page, flow);
    const source = '**Safe**\n\n<img src=x onerror="window.__markdownExecuted=true"><script>window.__markdownExecuted=true</script>';
    await streamEvent(page, flow, 'chunk', source);
    await expect(output.locator('strong')).toHaveText('Safe');
    await expect(output.locator('img, script')).toHaveCount(0);
    await expect(output).toContainText('<img src=x onerror="window.__markdownExecuted=true">');
    const finalHeading = await page.evaluate(flow => {
      window.__fire(`${flow}://chunk`, '\n\n## Last chunk');
      window.__fire(`${flow}://done`, '');
      window.__mock.resolveChat?.();
      return document.querySelector(flow === 'chat' ? '.msg-ai h2' : '#translation-text h2')?.textContent;
    }, flow);
    expect(finalHeading).toBe('Last chunk');
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(output.locator('h2')).toHaveText('Last chunk');
    await expect(output.locator('img, script')).toHaveCount(0);
    expect(await page.evaluate(() => window.__markdownExecuted)).toBeUndefined();
  });

  test(`${flow} renders Markdown tables across split headers, rows and escaped pipes`, async ({ page }) => {
    const output = await openStreamingOutput(page, flow);
    const chunks = [
      'A comparison.\r\n\r\n| Feature | Status | Count |\r\n| :--- | :--',
      '-: | ---: |\r\n| **Tables** | *Work',
      'ing* | `2` |\r\n| A\\',
      '|B | Ready | 3 |\r\n\r\nAfter the table.',
    ];
    await streamEvent(page, flow, 'chunk', chunks[0]);
    await expect(output.locator('table')).toHaveCount(0);
    await expect(output).toContainText('| Feature | Status | Count |');
    await streamEvent(page, flow, 'chunk', chunks[1]);
    await expect(output.getByRole('columnheader')).toHaveText(['Feature', 'Status', 'Count']);
    await expect(output.locator('tbody td')).toHaveText(['Tables', '*Work', '']);
    await streamEvent(page, flow, 'chunk', chunks[2]);
    await expect(output.locator('td em')).toHaveText('Working');
    await expect(output.locator('td code')).toHaveText('2');
    await streamEvent(page, flow, 'chunk', chunks[3]);
    await expect(output.locator('tbody td')).toHaveText(['Tables', 'Working', '2', 'A|B', 'Ready', '3']);
    await expect(output.locator('td strong')).toHaveText('Tables');
    await expect(output.locator('p')).toHaveText(['A comparison.', 'After the table.']);
    for (const [column, alignment] of ['left', 'center', 'right'].entries()) {
      await expect(output.locator('th').nth(column)).toHaveCSS('text-align', alignment);
      await expect(output.locator('td').nth(column)).toHaveCSS('text-align', alignment);
    }
    const streamedHtml = await output.innerHTML();
    await streamEvent(page, flow, 'done');
    expect(await output.innerHTML()).toBe(streamedHtml);
    if (flow === 'chat') {
      await send(page, 'Follow-up');
      expect((await requests(page)).at(-1).history[1].content).toBe(chunks.join(''));
    } else {
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async text => { window.__mock.copiedText = text; } },
        configurable: true,
      }));
      await page.locator('#copy-btn').click();
      expect(await page.evaluate(() => window.__mock.copiedText)).toBe(chunks.join(''));
    }
  });

  test(`${flow} scrolls wide Markdown tables inside the popup`, async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 450 });
    const output = await openStreamingOutput(page, flow);
    const headers = Array.from({ length: 8 }, (_, index) => `Column ${index + 1}`);
    const values = headers.map((_, index) => `long_identifier_${index + 1}`);
    const source = [headers.join(' | '), headers.map(() => '---').join(' | '), values.join(' | ')].join('\n');
    await streamEvent(page, flow, 'chunk', source);
    const wrapper = output.getByRole('region', { name: 'Table', exact: true });
    await expect(wrapper).toBeVisible();
    await expect(output.locator('td')).toHaveText(values);
    expect(await wrapper.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    expect(await output.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const contentArea = page.locator(flow === 'chat' ? '#transcript' : '#result-area');
    expect(await contentArea.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await wrapper.focus();
    // Keyboard scrolling animates; sample its final position before streaming.
    await wrapper.evaluate(element => {
      window.__tableScrollEnd = new Promise(resolve => {
        element.addEventListener('scrollend', () => resolve(element.scrollLeft), { once: true });
      });
    });
    await page.keyboard.press('ArrowRight');
    const scrollLeft = await page.evaluate(() => window.__tableScrollEnd);
    expect(scrollLeft).toBeGreaterThan(0);
    await streamEvent(page, flow, 'chunk', '\n' + values.join(' | '));
    await expect(output.locator('tbody tr')).toHaveCount(2);
    await expect(wrapper).toBeFocused();
    expect(await wrapper.evaluate(element => element.scrollLeft)).toBe(scrollLeft);
    await streamEvent(page, flow, 'done');
    await expect(wrapper).toBeFocused();
    expect(await wrapper.evaluate(element => element.scrollLeft)).toBe(scrollLeft);
    await expect(page.locator(flow === 'chat' ? '#send-btn' : '#copy-btn')).toBeInViewport();
  });

  for (const ending of ['done', 'error']) {
    test(`${flow} preserves code scrolling and text selection through streaming and ${ending}`, async ({ page }) => {
      const output = await openStreamingOutput(page, flow);
      await streamEvent(page, flow, 'chunk', '```js\nconst value = "' + 'long_value_'.repeat(100) + '";\n');
      const pre = output.locator('pre');
      await expect(pre).toBeVisible();
      await pre.focus();
      await pre.evaluate(element => {
        element.scrollLeft = 140;
        const text = element.querySelector('.hljs-keyword').firstChild;
        window.getSelection().setBaseAndExtent(text, text.length, text, 0);
      });
      expect(await page.evaluate(() => getSelection().toString())).toBe('const');
      await streamEvent(page, flow, 'chunk', 'console.log(value);\n```');
      await expect(pre).toContainText('console.log(value)');
      expect(await pre.evaluate(element => element.scrollLeft)).toBe(140);
      await expect(pre).toBeFocused();
      expect(await page.evaluate(() => getSelection().toString())).toBe('const');
      if (ending === 'error') await streamEvent(page, flow, 'error', { summary: 'Connection lost.', retryable: true });
      await streamEvent(page, flow, 'done');
      expect(await pre.evaluate(element => element.scrollLeft)).toBe(140);
      await expect(pre).toBeFocused();
      expect(await page.evaluate(() => getSelection().toString())).toBe('const');
      expect(await page.evaluate(() => getSelection().anchorOffset > getSelection().focusOffset)).toBe(true);
    });
  }

  test(`${flow} opens Markdown links externally and reports a failed browser launch`, async ({ page }) => {
    const output = await openStreamingOutput(page, flow);
    await streamEvent(page, flow, 'chunk', '[Documentation](https://example.com/docs?q=one&x=two)');
    await streamEvent(page, flow, 'done');
    const url = page.url();
    const link = output.getByRole('link', { name: 'Documentation' });
    await link.click();
    await expect.poll(() => requests(page, 'open_external_url')).toEqual([{ url: 'https://example.com/docs?q=one&x=two' }]);
    expect(page.url()).toBe(url);
    await page.evaluate(() => { window.__mock.openLinkError = true; });
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(output.getByRole('alert')).toContainText('Could not open this link');
    expect(page.url()).toBe(url);
  });

  test(`${flow} renders math, images and diagrams without overflowing a narrow popup`, async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 580 });
    const output = await openStreamingOutput(page, flow);
    const image = await page.evaluate(() => window.__screenshot('Markdown image'));
    const source = '#### Rich answer\n\n> A useful quote\n\n- [x] Complete\n- [ ] Pending\n\n$$\\sum_{i=1}^{n} i$$\n\n![Example](' + image + ')\n\n```mermaid\nflowchart TD\nA[Input] --> B[Output]\n```';
    await streamEvent(page, flow, 'chunk', source);
    await expect(output.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'ready');
    await expect(output.locator('h4')).toHaveText('Rich answer');
    await expect(output.locator('.katex')).toHaveCount(1);
    await expect(output.locator('.markdown-image')).toHaveAttribute('alt', 'Example');
    await expect(output.locator('input[type=checkbox]')).toHaveCount(2);
    const settledImage = await output.locator('.markdown-image').elementHandle();
    const settledDiagram = await output.locator('.markdown-diagram').elementHandle();
    await streamEvent(page, flow, 'chunk', '\n\nA follow-up paragraph.');
    await expect(output.locator('p').last()).toHaveText('A follow-up paragraph.');
    expect(await settledImage.evaluate(image => image.isConnected)).toBe(true);
    expect(await settledDiagram.evaluate(diagram => diagram.isConnected)).toBe(true);
    await streamEvent(page, flow, 'done');
    expect(await output.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.locator(flow === 'chat' ? '#transcript' : '#result-area').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(page.locator(flow === 'chat' ? '#send-btn' : '#copy-btn')).toBeInViewport();
  });

  test(`${flow} preserves pending Markdown on failure and clears it for retry`, async ({ page }) => {
    const output = await openStreamingOutput(page, flow);
    // Fail before the browser can paint the pending chunk.
    await page.evaluate(flow => {
      window.__fire(`${flow}://chunk`, '## Partial\n\n**Useful** text');
      window.__fire(`${flow}://error`, { summary: 'Connection lost.', retryable: true });
      window.__fire(`${flow}://done`, '');
      window.__mock.resolveChat?.();
    }, flow);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(output.locator('h2')).toHaveText('Partial');
    await expect(output.locator('strong')).toHaveText('Useful');
    await expect(page.locator('.error-summary')).toHaveText('Connection lost.');
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(output.locator('h2')).toHaveCount(0);
    await streamEvent(page, flow, 'chunk', '## Retried\n\nA **new** answer.');
    await expect(output.locator('h2')).toHaveText('Retried');
    await expect(output.locator('strong')).toHaveText('new');
    await streamEvent(page, flow, 'done');
    await expect(page.locator('.error-summary')).toBeHidden();
    await expect(output).not.toContainText('Useful');
  });
}

for (const ending of ['success', 'failure']) {
  test(`a screenshot captured during a ${ending} response remains pending`, async ({ page }) => {
    await openChat(page);
    await attach(page, 'First crop');
    await send(page, 'Explain the first crop');
    await expect(page.locator('#image-strip')).toBeHidden();
    await expect(page.locator('.msg-user .image-thumb')).toHaveCount(1);
    await attach(page, 'Next crop');
    if (ending === 'success') await complete(page); else await fail(page);
    await expect(page.locator('#image-strip .image-thumb')).toHaveCount(1);
    await send(page, 'Explain the next crop');
    const history = (await requests(page)).at(-1).history;
    expect(history.at(-1).content[0].text).toBe('Explain the next crop');
    expect(history.at(-1).content[1].image_url.url).not.toBe(history[0].content[1].image_url.url);
  });
}

test('retry replaces the failed turn using its original question and context', async ({ page }) => {
  await openChat(page);
  await send(page, 'Question A'); await fail(page);
  await send(page, 'Question B'); await complete(page, 'Answer B');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  expect((await requests(page)).at(-1)).toEqual({ selectedText: 'Selected source text.', history: [{ role: 'user', content: 'Question A' }] });
  await complete(page, 'Answer A');
  await expect(page.locator('.msg')).toHaveText(['Question A', 'Answer A', 'Question B', 'Answer B']);
  await send(page, 'Question C');
  expect((await requests(page)).at(-1).history.map(message => message.content)).toEqual(['Question A', 'Answer A', 'Question B', 'Answer B', 'Question C']);
});

test('a failed stream keeps partial text and waits for its terminal event', async ({ page }) => {
  await openChat(page);
  await send(page, 'Explain this');
  await page.evaluate(() => {
    window.__fire('chat://chunk', 'Useful partial reply');
    window.__fire('chat://error', { summary: 'Connection lost.', retryable: true });
  });
  await expect(page.locator('.partial-response')).toHaveText('Useful partial reply');
  await page.locator('#chat-input').fill('Next message');
  await expect(page.locator('#send-btn')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.__fire('chat://done', ''); window.__mock.resolveChat(); });
  await expect(page.locator('#send-btn')).toBeEnabled();
});

test('a command failure restores controls and allows retry', async ({ page }) => {
  await openChat(page, '', { sendError: true });
  await send(page, 'Question');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
  await expect(page.locator('.error-summary')).toHaveText('Could not start the request.');
  await page.evaluate(() => { window.__mock.sendError = false; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await complete(page);
  await expect(page.locator('.msg')).toHaveCount(2);
});

test('clearing context resets both the transcript and model history, preserving the draft', async ({ page }) => {
  await openChat(page);
  await send(page, 'Remember 7319'); await complete(page, 'Remembered');
  await page.locator('#chat-input').fill('My draft');
  await page.locator('#context-clear').click();
  await expect(page.locator('#reset-dialog')).toBeVisible();
  await page.locator('#confirm-reset-btn').click();
  await expect(page.locator('.msg')).toHaveCount(0);
  await expect(page.locator('#context-strip')).toBeHidden();
  await expect(page.locator('#chat-input')).toHaveValue('My draft');
  await page.locator('#send-btn').click();
  expect((await requests(page)).at(-1)).toEqual({ selectedText: '', history: [{ role: 'user', content: 'My draft' }] });
});

test('new chat can be cancelled without losing messages or draft', async ({ page }) => {
  await openChat(page);
  await send(page, 'Question'); await complete(page);
  await page.locator('#chat-input').fill('Draft');
  await page.locator('#new-chat-btn').click();
  await page.locator('#cancel-reset-btn').click();
  await expect(page.locator('.msg')).toHaveCount(2);
  await expect(page.locator('#chat-input')).toHaveValue('Draft');
});

test('new selection is offered without replacing the existing conversation', async ({ page }) => {
  await openChat(page);
  await send(page, 'Question'); await complete(page);
  await page.locator('#chat-input').fill('Draft');
  await page.evaluate(() => { window.__mock.pendingSelection = 'New source'; window.__fire('chat://selection-available', ''); });
  await expect(page.locator('#selection-notice')).toBeVisible();
  await expect(page.locator('.msg')).toHaveCount(2);
  await expect(page.locator('#chat-input')).toHaveValue('Draft');
  await expect(page.locator('#context-text')).toHaveText('Selected source text.');
  await page.locator('#use-selection-btn').click();
  await page.locator('#confirm-reset-btn').click();
  await expect(page.locator('#context-text')).toHaveText('New source');
  await expect(page.locator('.msg')).toHaveCount(0);
  await send(page, 'New question');
  expect((await requests(page)).at(-1).selectedText).toBe('New source');
});

test('startup consumes selections queued before listeners were ready', async ({ page }) => {
  await openChat(page, 'Original source', { pendingSelection: 'Queued source' });
  await expect(page.locator('#selection-notice')).toBeVisible();
  await expect(page.locator('#context-text')).toHaveText('Original source');
  await page.locator('#use-selection-btn').click();
  await expect(page.locator('#context-text')).toHaveText('Queued source');
});

test('only two screenshots survive across turns and eviction is visible', async ({ page }) => {
  await openChat(page, '');
  for (let index = 1; index <= 3; index++) {
    await attach(page, 'Crop ' + index);
    await send(page, 'Describe crop ' + index); await complete(page, 'Description ' + index);
  }
  const history = (await requests(page)).at(-1).history;
  const parts = history.flatMap(message => Array.isArray(message.content) ? message.content : []);
  expect(parts.filter(part => part.type === 'image_url')).toHaveLength(2);
  expect(parts.some(part => part.text === '[earlier screenshot removed from context]')).toBe(true);
  await expect(page.locator('.attachment-removed')).toHaveCount(1);
  await expect(page.locator('.msg-user .image-thumb')).toHaveCount(2);
});

test('removing a pending screenshot prevents it from being submitted', async ({ page }) => {
  await openChat(page, '');
  await attach(page, 'Wrong crop');
  await page.getByRole('button', { name: 'Remove screenshot 1', exact: true }).click();
  await expect(page.locator('#image-strip')).toBeHidden();
  await send(page, 'Text only');
  expect((await requests(page)).at(-1).history.at(-1).content).toBe('Text only');
});

test('screenshot preview supports keyboard access and Escape preserves chat', async ({ page }) => {
  await openChat(page, '');
  await attach(page, 'Preview');
  await page.getByRole('button', { name: 'Preview screenshot 1', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#image-dialog')).toBeVisible();
  await page.locator('#image-size-btn').click();
  await expect(page.locator('#image-size-btn')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#image-dialog')).toBeHidden();
  expect(await page.evaluate(() => window.__mock.closed)).toBe(false);
});

for (const followUp of [false, true]) {
  test(`${followUp ? 'a follow-up' : 'the first'} reply keeps its opening visible as it grows`, async ({ page }) => {
    await openChat(page, '');
    if (followUp) {
      await send(page, 'Previous question');
      await complete(page, 'An earlier paragraph.\n\n'.repeat(30));
    }
    await send(page, 'A long reply');
    const transcript = page.locator('#transcript');
    const output = page.locator('.msg-ai').last();
    await expect(output.locator('.typing')).toBeInViewport();
    const start = await transcript.evaluate(el => el.scrollTop);
    if (followUp) expect(start).toBeGreaterThan(0);
    else expect(start).toBe(0);

    await streamEvent(page, 'chat', 'chunk', '## Opening\n\nRead from here.');
    await expect(output.locator('h2')).toHaveText('Opening');
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(start);
    await streamEvent(page, 'chat', 'chunk', '\n\nA paragraph of explanation.\n\n'.repeat(30));
    await expect(output.locator('p')).toHaveCount(31);
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(start);
    await expect(output.locator('h2')).toBeInViewport();
    await expect(page.locator('#jump-latest')).toBeVisible();
    await complete(page, '\n\nFinal paragraph.');
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(start);
  });
}

for (const navigation of ['Jump to latest', 'manual scrolling']) {
  test(`${navigation} reaches the bottom once without following later chunks`, async ({ page }) => {
    await openChat(page, '');
    await send(page, 'Many paragraphs');
    await streamEvent(page, 'chat', 'chunk', 'A paragraph of explanation.\n\n'.repeat(30));
    await expect(page.locator('.msg-ai p')).toHaveCount(30);
    const transcript = page.locator('#transcript');
    await transcript.evaluate(el => { el.scrollTop = 0; });
    await expect(page.locator('#jump-latest')).toBeVisible();
    if (navigation === 'Jump to latest') await page.locator('#jump-latest').click();
    else await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
    await expect(page.locator('#jump-latest')).toBeHidden();
    expect(await transcript.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2);
    const position = await transcript.evaluate(el => el.scrollTop);

    // Even one more line below the viewport should be reachable with the button.
    await streamEvent(page, 'chat', 'chunk', 'Another line.');
    await expect(page.locator('.msg-ai p').last()).toHaveText('Another line.');
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(position);
    await expect(page.locator('#jump-latest')).toBeVisible();
    await complete(page, '\n\nEnd.');
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(position);
  });
}

for (const ending of ['success', 'failure']) {
  test(`${ending} preserves a reading position partway through a reply`, async ({ page }) => {
    await openChat(page, '');
    await send(page, 'Many paragraphs');
    await streamEvent(page, 'chat', 'chunk', 'A paragraph of explanation.\n\n'.repeat(30));
    await expect(page.locator('.msg-ai p')).toHaveCount(30);
    const transcript = page.locator('#transcript');
    await transcript.evaluate(el => { el.scrollTop = 160; });
    await expect(page.locator('#jump-latest')).toBeVisible();
    await streamEvent(page, 'chat', 'chunk', 'More content.');
    await expect(page.locator('.msg-ai p').last()).toHaveText('More content.');
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(160);
    if (ending === 'success') await complete(page, '\n\nEnd.');
    else await fail(page);
    expect(await transcript.evaluate(el => el.scrollTop)).toBe(160);
  });
}

test('composer, attachment and window resizing preserve the reading position', async ({ page }) => {
  await openChat(page, '');
  await send(page, 'Many paragraphs');
  await streamEvent(page, 'chat', 'chunk', 'A paragraph of explanation.\n\n'.repeat(30));
  await expect(page.locator('.msg-ai p')).toHaveCount(30);
  const transcript = page.locator('#transcript');
  await transcript.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('#jump-latest')).toBeHidden();
  const position = await transcript.evaluate(el => el.scrollTop);

  await page.locator('#chat-input').fill('A draft\nwith several\nlines to type');
  await expect(page.locator('#jump-latest')).toBeVisible();
  expect(await transcript.evaluate(el => el.scrollTop)).toBe(position);
  await attach(page, 'Next screenshot');
  await page.setViewportSize({ width: 500, height: 500 });
  // Let ResizeObserver callbacks run before checking the final position.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await transcript.evaluate(el => el.scrollTop)).toBe(position);
  await complete(page, '\n\nEnd.');
  expect(await transcript.evaluate(el => el.scrollTop)).toBe(position);
});

test('multiline and IME input do not accidentally send', async ({ page }) => {
  await openChat(page);
  await page.locator('#chat-input').fill('First line');
  await page.keyboard.press('Shift+Enter');
  await expect(page.locator('#chat-input')).toHaveValue('First line\n');
  await page.locator('#chat-input').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  expect(await requests(page)).toHaveLength(0);
  await page.keyboard.press('Enter');
  expect(await requests(page)).toHaveLength(1);
});

for (const flow of ['chat', 'translate']) {
  test(`${flow} has transparent outer edges and unclipped rounded chrome`, async ({ page }) => {
    await bridge(page);
    await page.goto(flow === 'chat' ? '/chat.html' : '/popup.html?original=Hello');
    const minimum = flow === 'chat' ? { width: 380, height: 320 } : { width: 360, height: 160 };
    for (const viewport of [{ width: 460, height: 340 }, minimum]) {
      await page.setViewportSize(viewport);
      const screenshot = await page.screenshot({ omitBackground: true });
      // Inspect the rendered pixels, not the CSS declarations: a transparent
      // html element alone doesn't prevent body background propagation.
      const pixels = await page.evaluate(async base64 => {
        const image = new Image();
        image.src = 'data:image/png;base64,' + base64;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const width = canvas.width, height = canvas.height;
        const alpha = (x, y) => context.getImageData(x, y, 1, 1).data[3];
        return {
          outer: [
            alpha(0, 0), alpha(width - 1, 0),
            alpha(0, height - 1), alpha(width - 1, height - 1),
            alpha(Math.floor(width / 2), 0), alpha(Math.floor(width / 2), height - 1),
            alpha(0, Math.floor(height / 2)), alpha(width - 1, Math.floor(height / 2)),
          ],
          center: alpha(Math.floor(width / 2), Math.floor(height / 2)),
        };
      }, screenshot.toString('base64'));
      expect(pixels.outer).toEqual(Array(8).fill(0));
      expect(pixels.center).toBe(255);
      await expect(page.locator('#close-btn')).toBeInViewport();
      await expect(page.locator(flow === 'chat' ? '#send-btn' : '#copy-btn')).toBeInViewport();
    }
  });
}

test('settings actions remain visible at the default window size', async ({ page }) => {
  await openSettings(page);
  await expect(page.locator('#save-btn')).toBeInViewport();
  await expect(page.locator('#test-btn')).toBeInViewport();
  await page.locator('[data-action="screenshot"]').scrollIntoViewIfNeeded();
  await expect(page.locator('#save-btn')).toBeInViewport();
  await expect(page.locator('#test-btn')).toBeInViewport();
});

test('older settings default to the system theme', async ({ page }) => {
  await openSettings(page);
  await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveValue('system');
});

for (const theme of ['system', 'light', 'dark']) {
  test(`${theme} theme is saved explicitly and restored when settings reopen`, async ({ page }) => {
    await openSettings(page, { config: { theme: theme === 'dark' ? 'light' : 'dark' } });
    const select = page.getByRole('combobox', { name: 'Theme', exact: true });
    await select.selectOption(theme);
    await expect(page.locator('#save-status')).toHaveText('Unsaved changes');
    expect(await requests(page, 'update_config')).toHaveLength(0);
    await page.locator('#save-btn').click();
    await expect(page.locator('#save-status')).toHaveText('Saved');
    expect((await requests(page, 'update_config')).at(-1).update.theme).toBe(theme);
    await page.reload();
    await expect(page.locator('#save-btn')).toBeEnabled();
    await expect(select).toHaveValue(theme);
  });
}

test('a failed theme save reports the error and preserves the saved preference', async ({ page }) => {
  await openSettings(page, { config: { theme: 'dark' }, saveError: true });
  const select = page.getByRole('combobox', { name: 'Theme', exact: true });
  await select.selectOption('light');
  await page.locator('#save-btn').click();
  await expect(page.locator('#save-status')).toContainText('Unable to save settings');
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue('light');
  await page.reload();
  await expect(page.locator('#save-btn')).toBeEnabled();
  await expect(select).toHaveValue('dark');
});

test('appearance navigation fits resized settings and supports keyboard controls', async ({ page }) => {
  await openSettings(page);
  for (const width of [360, 461, 480, 520, 600]) {
    await page.setViewportSize({ width, height: 420 });
    const nav = page.locator('.settings-nav');
    expect(await nav.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    for (const link of await page.locator('.nav-item').all()) await expect(link).toBeInViewport();
  }
  await page.setViewportSize({ width: 360, height: 420 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const appearance = page.getByRole('link', { name: 'Appearance', exact: true });
  await appearance.click();
  await expect(appearance).toHaveAttribute('aria-current', 'location');
  const select = page.getByRole('combobox', { name: 'Theme', exact: true });
  await expect(select).toBeInViewport();
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await expect(select).toHaveValue('light');
  await expect(page.locator('#save-btn')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('required fields block save and errors remain until corrected', async ({ page }) => {
  await openSettings(page);
  await page.clock.install();
  await page.locator('#model').fill('');
  await page.locator('#target-lang').fill('');
  await page.locator('#save-btn').click();
  expect(await requests(page, 'update_config')).toHaveLength(0);
  await expect(page.locator('#model')).toBeFocused();
  await expect(page.locator('#model-error')).toHaveText('Enter a model identifier.');
  await page.clock.fastForward(5000);
  await expect(page.locator('#model-error')).toBeVisible();
  await expect(page.locator('#save-status')).toHaveText('Check the highlighted fields.');
  await page.locator('#model').fill('test-model');
  await expect(page.locator('#model-error')).toBeHidden();
  await page.locator('#target-lang').fill('French');
  await page.locator('#save-btn').click();
  const saved = (await requests(page, 'update_config')).at(-1).update;
  expect(saved.target_language).toBe('French');
  expect(saved.hotkeys.translate.window_ms).toBe(800);
});

test('invalid URL stays highlighted while the replacement is still invalid', async ({ page }) => {
  await openSettings(page);
  await page.locator('#base-url').fill('invalid');
  await page.locator('#save-btn').click();
  await page.locator('#base-url').fill('still invalid');
  await expect(page.locator('#base-url')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#base-url-error')).toBeVisible();
  await page.locator('#base-url').fill('https://example.invalid/v1');
  await expect(page.locator('#base-url-error')).toBeHidden();
});

test('hotkey buttons allow Tab navigation and capture only after activation', async ({ page }) => {
  await openSettings(page);
  const trigger = page.getByRole('button', { name: 'Translate trigger key', exact: true });
  await trigger.focus();
  await expect(trigger).toHaveText('C');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Chat prefix', exact: true })).toBeFocused();
  await trigger.click();
  await expect(trigger).toHaveText('Press key…');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Chat prefix', exact: true })).toBeFocused();
  await expect(trigger).toHaveText('C');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('KeyD');
  await expect(trigger).toHaveText('D');
  await page.locator('#save-btn').click();
  expect((await requests(page, 'update_config')).at(-1).update.hotkeys.translate.then).toBe('D');
});

test('testing status persists while the connection is pending', async ({ page }) => {
  await openSettings(page, { testPending: true });
  await page.clock.install();
  await page.locator('#test-btn').click();
  await page.clock.fastForward(5000);
  await expect(page.locator('#save-status')).toHaveText('Testing connection…');
  await expect(page.locator('#test-btn')).toBeDisabled();
  await page.evaluate(() => window.__mock.resolveTest('OK'));
  await expect(page.locator('#save-status')).toHaveText('Connection succeeded. Save to apply.');
});

test('settings cannot overwrite configuration when initial loading failed', async ({ page }) => {
  await bridge(page, { loadError: true });
  await page.goto('/settings.html');
  await expect(page.locator('#save-status')).toContainText('Failed to load config');
  await expect(page.locator('#save-btn')).toBeDisabled();
  await expect(page.locator('#test-btn')).toBeDisabled();
});

test('helper text and primary actions have readable contrast', async ({ page }) => {
  await openSettings(page);
  const ratios = await page.evaluate(() => {
    function luminance(rgb) {
      const parts = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
      return parts[0] * 0.2126 + parts[1] * 0.7152 + parts[2] * 0.0722;
    }
    function ratio(a, b) {
      const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
      return (values[0] + 0.05) / (values[1] + 0.05);
    }
    const hint = getComputedStyle(document.querySelector('.field-hint'));
    const save = getComputedStyle(document.getElementById('save-btn'));
    return [ratio(hint.color, getComputedStyle(document.body).backgroundColor), ratio(save.color, save.backgroundColor)];
  });
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
});

test('chat controls fit the minimum window size', async ({ page }) => {
  await openChat(page, '');
  await page.setViewportSize({ width: 380, height: 320 });
  await attach(page, 'Crop');
  await expect(page.locator('#chat-input')).toBeInViewport();
  await expect(page.locator('#send-btn')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('expanded source, a new selection and attachments leave the composer accessible', async ({ page }) => {
  await openChat(page, 'A long source paragraph. '.repeat(60), { pendingSelection: 'Another source' });
  await page.setViewportSize({ width: 380, height: 320 });
  await page.locator('#context-text').click();
  await attach(page, 'Crop');
  await page.locator('#chat-input').fill('A multiline draft\n'.repeat(12));
  for (const id of ['chat-input', 'send-btn']) {
    const bounds = await page.locator('#' + id).boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(320);
  }
});

const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.setContent('<base href="http://127.0.0.1:8766/"><main id="output"></main>');
  for (const url of ['theme.css', 'vendor/katex.css', 'markdown.css']) await page.addStyleTag({ url });
  for (const url of ['vendor/markdown-libs.js', 'markdown.js']) await page.addScriptTag({ url });
  await page.evaluate(() => { window.__renderer = createMarkdownRenderer(document.getElementById('output')); });
});

async function render(page, source) {
  await page.evaluate(source => {
    window.__renderer.flush(source);
  }, source);
  return page.locator('#output');
}

test('tables accept optional outer pipes, short delimiters and uneven body rows', async ({ page }) => {
  const output = await render(page, [
    'Name | Count',
    ':-- | -:',
    'Alice | 1',
    '| Bob |',
    'Cara | 3 | ignored',
    'Dan',
    '| | 5 |',
    '',
    '| Single |',
    '| --- |',
    '| value |',
    '',
    '| Header only |',
    '| --- |',
  ].join('\n'));
  await expect(output.locator('table')).toHaveCount(3);
  await expect(output.locator('table').first().locator('th')).toHaveText(['Name', 'Count']);
  await expect(output.locator('table').first().locator('td')).toHaveText(['Alice', '1', 'Bob', '', 'Cara', '3', 'Dan', '', '', '5']);
  await expect(output.locator('table').nth(1).locator('td')).toHaveText('value');
  await expect(output.locator('table').last().locator('th')).toHaveText('Header only');
  await expect(output.locator('table').last().locator('tbody')).toHaveCount(0);
});

test('table cells preserve escaped pipes and keep HTML inert', async ({ page }) => {
  const output = await render(page, [
    '| A\\|B | Example |',
    '| --- | --- |',
    '| **C\\|D** | `a\\|b` |',
    '| <img src=x onerror="window.__markdownExecuted=true"> | <script>window.__markdownExecuted=true</script> |',
    '| &lt;img src=x onerror=alert(1)&gt; | </td><iframe srcdoc="<script>alert(1)</script>"> |',
  ].join('\n'));
  await expect(output.locator('th')).toHaveText(['A|B', 'Example']);
  await expect(output.locator('strong')).toHaveText('C|D');
  await expect(output.locator('code')).toHaveText('a|b');
  await expect(output.locator('tbody tr')).toHaveCount(3);
  await expect(output.locator('td')).toHaveCount(6);
  await expect(output.locator('img, script, iframe')).toHaveCount(0);
  await expect(output).toContainText('<img src=x onerror="window.__markdownExecuted=true">');
  await expect(output).toContainText('<img src=x onerror=alert(1)>');
  expect(await page.evaluate(() => window.__markdownExecuted)).toBeUndefined();
});

test('table detection preserves malformed tables, fenced examples and following blocks', async ({ page }) => {
  for (const source of [
    '| A | B |\n| --- |\n| value |',
    '| A | B |\n| --:-- | --- |\n| value | next |',
    '| A | B |\n| value | next |',
    '```markdown\n| A | B |\n| --- | --- |\n| value | next |\n```',
  ]) {
    const output = await render(page, source);
    await expect(output.locator('table')).toHaveCount(0);
    await expect(output).toContainText(source.startsWith('```') ? '| --- | --- |' : source.split('\n')[0].replace('\\|', '|'));
  }

  const output = await render(page, [
    '- Before',
    '',
    '| A | B |',
    '| --- | --- |',
    '| one | two |',
    '# Heading | text',
    '| C | D |',
    '| --- | --- |',
    '| three | four |',
    '- After | list',
    '',
    '| E | F |',
    '| --- | --- |',
    '| five | six |',
    '```',
    '| Literal | code |',
    '```',
  ].join('\n'));
  await expect(output.locator('table')).toHaveCount(3);
  await expect(output.locator('tbody tr')).toHaveCount(3);
  await expect(output.locator('h1')).toHaveText('Heading | text');
  await expect(output.locator('ul li')).toHaveText(['Before', 'After | list']);
  await expect(output.locator('ul table')).toHaveCount(0);
  await expect(output.locator('pre code')).toHaveText('| Literal | code |');
});

test('inline code and escapes keep literal characters while nested emphasis renders', async ({ page }) => {
  const output = await render(page, [
    '`**literal** *stars* <tag> $x$` and ``a ` b``',
    '',
    String.raw`\*literal\* and \_literal\_ and \$5`,
    '',
    '**bold with *italic* inside** and __strong__ and _emphasis_',
  ].join('\n'));
  await expect(output.locator('code')).toHaveText(['**literal** *stars* <tag> $x$', 'a ` b']);
  await expect(output.locator('code strong, code em, code .katex')).toHaveCount(0);
  await expect(output.locator('p').nth(1)).toHaveText('*literal* and _literal_ and $5');
  await expect(output.locator('strong')).toHaveText(['bold with italic inside', 'strong']);
  await expect(output.locator('strong em')).toHaveText('italic');
});

test('fences honor delimiter lengths, literal closing-like lines and language highlighting', async ({ page }) => {
  const output = await render(page, [
    '````markdown', '```js', 'const answer = 42;', '```', '````', '',
    '~~~txt', 'first', '~~~not a closing fence', 'last', '~~~', '',
    '```javascript', 'const text = "<img src=x onerror=alert(1)>";', '```', '',
    '```unknown-language', '**plain** <script>not executable</script>', '```', '',
    '    indented code',
  ].join('\n'));
  await expect(output.locator('pre code')).toHaveText([
    '```js\nconst answer = 42;\n```\n', 'first\n~~~not a closing fence\nlast\n',
    'const text = "<img src=x onerror=alert(1)>";\n', '**plain** <script>not executable</script>\n', 'indented code\n',
  ]);
  await expect(output.locator('pre').nth(2).locator('.hljs-keyword')).toHaveText('const');
  await expect(output.locator('img, script')).toHaveCount(0);
});

test('lists preserve nesting, continuation paragraphs and starting numbers', async ({ page }) => {
  const output = await render(page, '- Parent\n  - Child\n- Next\n\n3. Third\n   continued line\n4. Fourth\n\n1) One\n2) Two');
  await expect(output.locator('ul > li > ul > li')).toHaveText('Child');
  await expect(output.locator('ol').first()).toHaveAttribute('start', '3');
  await expect(output.locator('ol').first().locator('li')).toHaveText(['Third continued line', 'Fourth']);
  await expect(output.locator('ol').last().locator('li')).toHaveText(['One', 'Two']);
});

test('headings, quotes, hard breaks, tasks and strikethrough render as structured content', async ({ page }) => {
  const output = await render(page, '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six\n\n> Quote\n>\n> Second paragraph\n\nFirst  \nSecond\\\nThird\n\n---\n\n- [x] Done\n- [ ] Todo\n\n~~old~~');
  await expect(output.locator('h1,h2,h3,h4,h5,h6')).toHaveText(['One', 'Two', 'Three', 'Four', 'Five', 'Six']);
  await expect(output.locator('blockquote p')).toHaveText(['Quote', 'Second paragraph']);
  await expect(output.locator('br')).toHaveCount(2);
  await expect(output.locator('hr')).toHaveCount(1);
  await expect(output.locator('input[type=checkbox]')).toHaveCount(2);
  await expect(output.locator('input').first()).toBeChecked();
  await expect(output.locator('input').last()).not.toBeChecked();
  for (const input of await output.locator('input').all()) await expect(input).toBeDisabled();
  await expect(output.locator('s')).toHaveText('old');
});

test('tables stop at horizontal rules, lower headings and tilde fences', async ({ page }) => {
  for (const ending of ['---\nAfter', '#### After', '~~~txt\nAfter\n~~~']) {
    const output = await render(page, '| A | B |\n| --- | --- |\n| one | two |\n' + ending);
    await expect(output.locator('tbody tr')).toHaveCount(1);
    await expect(output.locator('table')).not.toContainText('After');
    await expect(output).toContainText('After');
  }
});

test('links and references work while unsafe URL schemes and raw HTML stay inert', async ({ page }) => {
  const output = await render(page, [
    '[Docs](https://example.com/docs?a=1&b=2) https://example.org <hello@example.com>',
    '', '[Reference][ref]', '', '[ref]: https://example.net/reference "Title"', '',
    '[bad](javascript:alert%281%29) [bad](JaVaScRiPt:alert%281%29) [bad](java&#x73;cript:alert%281%29)',
    '[local](file:///etc/passwd) [data](data:text/html;base64,PHNjcmlwdD4=) [app](tauri://localhost)',
    '[relative](/settings.html) [credentials](https://user:password@example.com)', '',
    '<img src=x onerror="window.__executed=true"><script>window.__executed=true</script>',
    '<svg onload="window.__executed=true"></svg><iframe srcdoc="<script>alert(1)</script>"></iframe>',
  ].join('\n'));
  const urls = await output.locator('a[href]').evaluateAll(links => links.map(link => link.getAttribute('href')));
  expect(urls).toEqual(expect.arrayContaining([
    'https://example.com/docs?a=1&b=2', 'https://example.org/', 'mailto:hello@example.com', 'https://example.net/reference',
  ]));
  for (const value of urls) {
    const url = new URL(value);
    expect(['http:', 'https:', 'mailto:']).toContain(url.protocol);
    expect(url.username).toBe('');
    expect(url.password).toBe('');
  }
  await expect(output.locator('img, script, svg, iframe')).toHaveCount(0);
  expect(await page.evaluate(() => window.__executed)).toBeUndefined();
});

test('Markdown images load, preserve alt text and reject executable or local sources', async ({ page }) => {
  const png = await page.evaluate(() => { const canvas = document.createElement('canvas'); return canvas.toDataURL(); });
  await page.route('https://example.com/image.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(png.split(',')[1], 'base64') }));
  const output = await render(page, `![A diagram](https://example.com/image.png "Preview")\n\n![Embedded](${png})\n\n![bad](file:///etc/passwd)\n![bad](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+)`);
  await expect(output.locator('img')).toHaveCount(2);
  await expect(output.locator('img').first()).toHaveAttribute('alt', 'A diagram');
  await expect(output.locator('img').first()).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect.poll(() => output.locator('img').first().evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  const image = await output.locator('img').first().elementHandle();
  await page.evaluate(() => window.__renderer.schedule(document.querySelector('#output img').outerHTML));
  // A raw model-provided HTML image remains text, even after an actual Markdown image.
  await expect(output.locator('img')).toHaveCount(0);
  expect(await image.evaluate(img => img.isConnected)).toBe(false);
});

test('math supports dollar and bracket delimiters without executing trusted-only commands', async ({ page }) => {
  const output = await render(page, String.raw`Inline $E=mc^2$ and \(x^2\).

$$\frac{1}{2}$$

\[\sum_{i=1}^n i\]

Cost is $5 and $10. Code: ` + '`$literal$`.' + String.raw`

$\href{javascript:alert(1)}{bad}$ and $\htmlStyle{background:red}{bad}$`);
  await expect(output.locator('.katex')).toHaveCount(6);
  await expect(output.locator('.markdown-math')).toHaveCount(2);
  await expect(output.locator('a[href], [style*="background:red"]')).toHaveCount(0);
  await expect(output).toContainText('Cost is $5 and $10.');
  await expect(output.locator('code')).toHaveText('$literal$');
});

test('invalid math falls back to readable source and macro expansion is bounded', async ({ page }) => {
  const output = await render(page, String.raw`$\notARealCommand{<img src=x>}$

$$\def\a{\a}\a$$

$x+1$`);
  await expect(output.locator('.math-fallback')).toHaveCount(2);
  await expect(output.locator('.math-fallback').first()).toContainText('<img src=x>');
  await expect(output.locator('img, script')).toHaveCount(0);
  await expect(output.locator('.katex')).toHaveCount(1);
});

for (const diagram of ['flowchart LR\nA[Start] --> B[Finish]', 'sequenceDiagram\nAlice->>Bob: Hello']) {
  test(`Mermaid renders ${diagram.split('\n')[0]} locally as an inert image`, async ({ page }) => {
    const outsideRequests = [];
    page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:8766/')) outsideRequests.push(request.url()); });
    const output = await render(page, '```mermaid\n' + diagram + '\n```');
    await expect(output.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'ready');
    await expect.poll(() => output.locator('.markdown-diagram-image').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
    await expect(output.locator('svg, iframe, script, foreignObject')).toHaveCount(0);
    expect(outsideRequests).toEqual([]);
    await output.locator('summary').click();
    await expect(output.locator('pre')).toBeVisible();
    await expect(output.locator('pre')).toHaveText(diagram);
  });
}

test('invalid or configured Mermaid preserves source and cannot affect later diagrams', async ({ page }) => {
  for (const diagram of ['not a valid diagram', '%%{init: {"securityLevel":"loose","themeCSS":"body{display:none}"}}%%\nflowchart LR\nA-->B']) {
    const output = await render(page, '```mermaid\n' + diagram + '\n```');
    await expect(output.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'error');
    await expect(output.locator('pre')).toHaveText(diagram);
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('.diagram-workspace')).toHaveCount(0);
  }
  const output = await render(page, '```mermaid\nflowchart TD\nA-->B\n```');
  await expect(output.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'ready');
});

test('clearing a response discards delayed Mermaid work', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/vendor/mermaid.js', async route => { await gate; await route.continue(); });
  const output = await render(page, '```mermaid\nflowchart TD\nA-->B\n```');
  await expect(output.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'pending');
  await render(page, 'New response');
  release();
  await page.waitForFunction(() => !!window.MermaidLib);
  await expect(output).toHaveText('New response');
  await expect(output.locator('img, .markdown-diagram')).toHaveCount(0);
  await expect(page.locator('.diagram-workspace')).toHaveCount(0);
});

test('Mermaid labels and click directives cannot create active content', async ({ page }) => {
  const output = await render(page, '```mermaid\nflowchart TD\nA["&lt;script&gt;window.__executed=true&lt;/script&gt;"] --> B[End]\nclick B "javascript:alert(1)"\n```');
  await expect(output.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'ready');
  const svg = await output.locator('.markdown-diagram-image').evaluate(img => decodeURIComponent(img.src.split(',').slice(1).join(',')));
  expect(svg).not.toMatch(/<script\b|<foreignObject\b|\son\w+=|(?:href|src)=["']javascript:/i);
  expect(await page.evaluate(() => window.__executed)).toBeUndefined();
  await expect(page.locator('.diagram-workspace')).toHaveCount(0);
});

test('finishing a streamed diagram preserves source selection, focus and scroll while its preview loads', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/vendor/mermaid.js', async route => { await gate; await route.continue(); });
  const source = '```mermaid\nflowchart LR\nA["' + 'Long source label '.repeat(12) + '"] --> B[End]\n';
  await page.evaluate(source => window.__renderer.schedule(source), source);
  const output = page.locator('#output');
  await expect(output.locator('pre')).toContainText('Long source label');
  expect(await page.evaluate(() => !!window.MermaidLib)).toBe(false);
  await output.locator('pre').evaluate(pre => {
    pre.focus();
    pre.scrollLeft = 100;
    const text = pre.querySelector('code').firstChild;
    getSelection().setBaseAndExtent(text, 0, text, 12);
  });
  await page.evaluate(source => window.__renderer.schedule(source + '```'), source);
  await expect(output.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'pending');
  await expect(output.locator('pre')).toBeFocused();
  await expect(output.locator('pre')).toBeVisible();
  expect(await output.locator('pre').evaluate(pre => pre.scrollLeft)).toBe(100);
  expect(await page.evaluate(() => getSelection().toString())).toBe('flowchart LR');
  release();
  await expect(output.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'ready');
  await expect(output.locator('pre')).toBeFocused();
  await expect(output.locator('pre')).toBeVisible();
  expect(await page.evaluate(() => getSelection().toString())).toBe('flowchart LR');
});

test('removing a response root discards its delayed diagram without blocking later replies', async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/vendor/mermaid.js', async route => { await gate; await route.continue(); });
  await render(page, '```mermaid\nflowchart LR\nA-->B\n```');
  await page.evaluate(() => {
    window.__removed = document.getElementById('output');
    window.__removed.remove();
    const next = document.createElement('main');
    next.id = 'next';
    document.body.appendChild(next);
    createMarkdownRenderer(next).flush('```mermaid\nflowchart TD\nC-->D\n```');
  });
  release();
  await expect(page.locator('#next .markdown-diagram')).toHaveAttribute('data-diagram-state', 'ready');
  expect(await page.evaluate(() => window.__removed.querySelectorAll('img').length)).toBe(0);
  await expect(page.locator('.diagram-workspace')).toHaveCount(0);
});

test('diagrams nested in a growing quote keep their preview and source disclosure', async ({ page }) => {
  const source = '> ```mermaid\n> flowchart TD\n> A-->B\n> ```';
  const output = await render(page, source);
  await expect(output.locator('.markdown-diagram')).toHaveAttribute('data-diagram-state', 'ready');
  await output.locator('summary').click();
  const image = await output.locator('.markdown-diagram-image').elementHandle();
  await page.evaluate(source => window.__renderer.schedule(source + '\n>\n> More in the quote.'), source);
  await expect(output.locator('blockquote p')).toHaveText('More in the quote.');
  expect(await image.evaluate(img => img.isConnected)).toBe(true);
  await expect(output.locator('pre')).toBeVisible();
  const quote = await output.locator('blockquote').elementHandle();
  await page.evaluate(source => window.__renderer.schedule(source + '\n>\n> More in the quote.\n\nOutside the quote.'), source);
  await expect(output).toContainText('Outside the quote.');
  expect(await quote.evaluate(node => node.isConnected)).toBe(true);
  expect(await image.evaluate(img => img.isConnected)).toBe(true);
});

test('wide diagrams stay readable and retain keyboard scroll after a theme change', async ({ page }, testInfo) => {
  const output = await render(page, '```mermaid\nflowchart LR\nA[First step] --> B[Second step] --> C[Third step] --> D[Fourth step] --> E[Last step]\n```');
  const block = output.locator('.markdown-diagram');
  const preview = output.locator('.diagram-preview');
  await expect(block).toHaveAttribute('data-diagram-state', 'ready');
  expect(await preview.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await preview.focus();
  await preview.evaluate(node => { node.scrollLeft = 100; });
  const theme = testInfo.project.use.colorScheme === 'dark' ? 'light' : 'dark';
  await page.emulateMedia({ colorScheme: theme });
  await expect(block).toHaveAttribute('data-diagram-theme', theme);
  await expect(preview).toBeFocused();
  expect(await preview.evaluate(node => node.scrollLeft)).toBe(100);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => preview.evaluate(node => node.scrollLeft)).toBeGreaterThan(100);
});

test('a selection containing only an image does not block the next streamed chunk', async ({ page }) => {
  const png = await page.evaluate(() => document.createElement('canvas').toDataURL());
  const source = `![Example](${png})`;
  const output = await render(page, source);
  await output.locator('img').evaluate(img => {
    const range = document.createRange();
    range.selectNode(img);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.evaluate(source => window.__renderer.schedule(source + '\n\nMore text'), source);
  await expect(output).toContainText('More text');
});

test('selections across messages and completing emphasis keep the selected text', async ({ page }) => {
  await render(page, '**Important** and selected text');
  await page.evaluate(() => {
    const output = document.getElementById('output');
    const before = document.createElement('p');
    before.id = 'earlier-message';
    before.textContent = 'Earlier message';
    output.before(before);
    const text = output.querySelector('p').lastChild;
    getSelection().setBaseAndExtent(before.firstChild, 8, text, text.length);
    window.__selected = getSelection().toString();
    window.__renderer.schedule('**Important** and selected text with more');
  });
  await expect(page.locator('#output')).toContainText('with more');
  expect(await page.evaluate(() => getSelection().toString())).toBe(await page.evaluate(() => window.__selected));
  await render(page, '**Important and selected text');
  await page.evaluate(() => {
    const text = document.querySelector('#output p').firstChild;
    getSelection().setBaseAndExtent(text, text.textContent.indexOf('selected'), text, text.length);
    window.__renderer.schedule('**Important and selected text**');
  });
  await expect(page.locator('#output strong')).toHaveText('Important and selected text');
  expect(await page.evaluate(() => getSelection().toString())).toBe('selected text');
});

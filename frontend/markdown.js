// Shared, locally bundled Markdown. Model HTML stays text; external content
// has explicit URL policies, and diagrams are displayed as inert SVG images.
(function (global) {
  const { MarkdownIt, tex, tasklist, katex, hljs, DOMPurify } = global.MarkdownLib;
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });
  const escapeHtml = md.utils.escapeHtml;
  const assetBase = new URL('.', document.currentScript.src);
  const colorScheme = global.matchMedia('(prefers-color-scheme: dark)');

  function safeUrl(value, image = false) {
    if (/[\u0000-\u0020\u007f]/.test(value)) return null;
    if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(value)) return value;
    try {
      const url = new URL(value);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href;
      if (!image && url.protocol === 'mailto:' && url.pathname) return url.href;
    } catch (_error) { /* Relative paths and app/file URLs are not external links. */ }
    return null;
  }
  md.validateLink = value => safeUrl(value, true) !== null || safeUrl(value) !== null;

  function math(content, displayMode) {
    try {
      if (content.length > 10000) throw new Error('Math is too long');
      const html = katex.renderToString(content, {
        displayMode, trust: false, throwOnError: true, strict: 'ignore',
        maxExpand: 1000, maxSize: 10, macros: {}, output: 'htmlAndMathml',
      });
      return displayMode ? `<div class="markdown-math" tabindex="0" role="region" aria-label="Formula">${html}</div>` : html;
    } catch (_error) {
      const tag = displayMode ? 'pre' : 'code';
      return `<${tag} class="math-fallback" title="Formula could not be displayed">${escapeHtml(content)}</${tag}>`;
    }
  }
  md.use(tex, { delimiters: 'all', render: math });
  md.use(tasklist, { disabled: true, label: false });
  md.renderer.rules.checkbox_input = (tokens, index) => {
    const checked = tokens[index].attrGet('checked') != null;
    return `<input class="task-list-item-checkbox" type="checkbox" disabled${checked ? ' checked' : ''} aria-label="${checked ? 'Completed' : 'Incomplete'} task">`;
  };
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const url = safeUrl(token.attrGet('href') || '');
    if (!url) return '<a>';
    token.attrSet('href', url);
    token.attrSet('class', 'markdown-link');
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
    return renderer.renderToken(tokens, index, options);
  };
  md.renderer.rules.image = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const alt = renderer.renderInlineAsText(token.children, options, env);
    const src = safeUrl(token.attrGet('src') || '', true);
    if (!src) return escapeHtml(alt);
    const title = token.attrGet('title');
    return `<img class="markdown-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title ? ` title="${escapeHtml(title)}"` : ''} loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  };
  md.renderer.rules.table_open = (tokens, index) => `<div class="markdown-table" data-md-block="${tokens[index].map[0]}" role="region" aria-label="Table" tabindex="0"><table>`;
  md.renderer.rules.table_close = () => '</table></div>\n';
  md.renderer.rules.th_open = (tokens, index, options, env, renderer) => {
    tokens[index].attrSet('scope', 'col');
    return renderer.renderToken(tokens, index, options);
  };

  function codeBlock(content, language, key = '') {
    let html = escapeHtml(content);
    // Explicit languages only; auto-detection is expensive and often misleading.
    if (content.length <= 100000 && hljs.getLanguage(language)) {
      try { html = hljs.highlight(content, { language, ignoreIllegals: true }).value; } catch (_error) { /* Keep plain code. */ }
    }
    return `<pre${key ? ` data-md-block="${key}"` : ''} tabindex="0" aria-label="Code block"><code class="hljs">${html}</code></pre>\n`;
  }
  md.renderer.rules.code_block = (tokens, index) => codeBlock(tokens[index].content, '', String(tokens[index].map[0]));
  md.renderer.rules.fence = (tokens, index, options, env) => {
    const token = tokens[index];
    const language = token.info.trim().split(/\s+/)[0].toLowerCase();
    const key = String(token.map[0]);
    if (['math', 'latex', 'tex'].includes(language)) return `<div data-md-block="${key}">${math(token.content, true)}</div>\n`;
    if (language === 'mermaid') {
      const lastLine = (env.lines[token.map[1] - 1] || '').trim().replace(/^(?:>\s*)+/, '');
      const fence = lastLine.match(/^(`{3,}|~{3,})\s*$/);
      const closed = fence && fence[1][0] === token.markup[0] && fence[1].length >= token.markup.length;
      if (env.final || closed) {
        return `<div class="markdown-diagram" data-md-block="${key}" data-diagram="${escapeHtml(token.content)}">`
          + '<div class="diagram-preview" tabindex="0" role="region" aria-label="Diagram" aria-busy="true">Rendering diagram…</div>'
          + '<details><summary>Diagram source</summary>' + codeBlock(token.content, '') + '</details></div>\n';
      }
    }
    return codeBlock(token.content, language, key);
  };

  function render(source, final = true) {
    const text = String(source == null ? '' : source).replace(/\r\n?/g, '\n');
    const env = { final, lines: text.split('\n') };
    const tokens = md.parse(text, env);
    for (const token of tokens) {
      if (token.level === 0 && token.map && token.nesting !== -1) token.attrSet('data-md-block', String(token.map[0]));
    }
    return md.renderer.render(tokens, md.options, env);
  }

  let diagramLibrary;
  let diagramQueue = Promise.resolve();
  let diagramId = 0;
  function loadDiagrams() {
    if (!diagramLibrary) diagramLibrary = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('vendor/mermaid.js', assetBase).href;
      script.onload = () => resolve(global.MermaidLib);
      script.onerror = () => { script.remove(); diagramLibrary = null; reject(new Error('Diagram library unavailable')); };
      document.head.appendChild(script);
    });
    return diagramLibrary;
  }
  function enhanceDiagrams(element, changed) {
    for (const block of element.querySelectorAll('.markdown-diagram:not([data-diagram-state])')) {
      block.dataset.diagramState = 'pending';
      const current = () => element.isConnected && element.contains(block);
      const preview = block.querySelector('.diagram-preview');
      preview.setAttribute('aria-busy', 'true');
      // Mermaid uses shared state. Serialize jobs, and discard late results for
      // blocks removed by an error, reset, or retry.
      diagramQueue = diagramQueue.then(async () => {
        if (!current()) return;
        let container;
        try {
          const mermaid = await loadDiagrams();
          if (!current()) return;
          const source = block.dataset.diagram;
          if (source.length > 50000) throw new Error('Diagram is too long');
          if (/%%\s*\{|^\s*---/.test(source)) throw new Error('Diagram configuration is not supported');
          const dark = colorScheme.matches;
          mermaid.initialize({
            startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
            theme: dark ? 'dark' : 'default',
            htmlLabels: false, flowchart: { htmlLabels: false },
            maxTextSize: 50000, maxEdges: 500,
            secure: Object.keys(mermaid.mermaidAPI.getConfig()),
          });
          container = document.createElement('div');
          container.className = 'diagram-workspace';
          document.body.appendChild(container);
          const { svg } = await mermaid.render(`contextkey-diagram-${++diagramId}`, source, container);
          if (!current()) return;
          if (dark !== colorScheme.matches) { delete block.dataset.diagramState; return; }
          const clean = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ['foreignObject', 'a', 'image', 'script'],
          });
          const img = document.createElement('img');
          img.className = 'markdown-diagram-image';
          img.alt = 'Diagram';
          const bounds = new DOMParser().parseFromString(clean, 'image/svg+xml').documentElement.viewBox?.baseVal;
          if (bounds?.width > 0 && bounds.height > 0) {
            img.width = Math.ceil(bounds.width);
            img.height = Math.ceil(bounds.height);
          }
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(clean);
          const left = preview.scrollLeft;
          const top = preview.scrollTop;
          preview.replaceChildren(img);
          preview.scrollLeft = left;
          preview.scrollTop = top;
          block.dataset.diagramTheme = dark ? 'dark' : 'light';
          block.dataset.diagramState = 'ready';
        } catch (_error) {
          if (!current()) return;
          preview.textContent = 'Diagram could not be displayed. Its source is available below.';
          block.querySelector('details').open = true;
          block.dataset.diagramState = 'error';
        } finally {
          container?.remove();
          if (current()) {
            preview.removeAttribute('aria-busy');
            changed();
            if (!block.dataset.diagramState) enhanceDiagrams(element, changed);
          }
        }
      });
    }
  }

  function textOffset(root, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  }
  function textPoint(root, offset, preferNext) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (offset < node.length || (offset === node.length && !preferNext)) return [node, offset];
      offset -= node.length;
    }
    return [root, root.childNodes.length];
  }
  function preserveView(element, update) {
    const scrollKind = node => node.tagName === 'PRE' ? 'pre' : node.className;
    const scrollers = [...element.querySelectorAll('pre, .markdown-table, .markdown-math, .diagram-preview')].map(node => ({
      node, left: node.scrollLeft, top: node.scrollTop, focused: node === document.activeElement,
      key: node.closest('[data-md-block]')?.dataset.mdBlock,
    }));
    const selection = global.getSelection();
    let saved;
    if (selection.rangeCount && !selection.isCollapsed
        && (element.contains(selection.anchorNode) || element.contains(selection.focusNode))) {
      const point = (node, offset) => element.contains(node)
        ? { inside: true, offset: textOffset(element, node, offset) } : { node, offset };
      const range = selection.getRangeAt(0);
      saved = {
        anchor: point(selection.anchorNode, selection.anchorOffset), focus: point(selection.focusNode, selection.focusOffset),
        text: selection.toString(), backward: range.startContainer === selection.focusNode && range.startOffset === selection.focusOffset,
      };
    }
    update();
    const nextScrollers = [...element.querySelectorAll('pre, .markdown-table, .markdown-math, .diagram-preview')];
    scrollers.forEach((saved, index) => {
      const node = element.contains(saved.node) ? saved.node : nextScrollers.find(candidate =>
        scrollKind(candidate) === scrollKind(saved.node) && candidate.closest('[data-md-block]')?.dataset.mdBlock === saved.key) || nextScrollers[index];
      if (!node) return;
      if (saved.focused) node.closest('details')?.setAttribute('open', '');
      node.scrollLeft = saved.left;
      node.scrollTop = saved.top;
      if (saved.focused && document.activeElement !== node) node.focus({ preventScroll: true });
    });
    if (saved) {
      // Completing delimiters can move offsets before the selected literal text.
      if (saved.anchor.inside && saved.focus.inside && saved.text) {
        const content = element.textContent;
        const start = Math.min(saved.anchor.offset, saved.focus.offset);
        let best = -1;
        for (let found = content.indexOf(saved.text); found !== -1; found = content.indexOf(saved.text, found + 1)) {
          if (best === -1 || Math.abs(found - start) < Math.abs(best - start)) best = found;
        }
        if (best !== -1) {
          const backward = saved.anchor.offset > saved.focus.offset;
          saved.anchor.offset = best + (backward ? saved.text.length : 0);
          saved.focus.offset = best + (backward ? 0 : saved.text.length);
        }
      }
      // At text-node boundaries, start inside the following node so selecting
      // code does not accidentally include the preceding block's line break.
      const resolve = (point, preferNext) => point.inside ? textPoint(element, point.offset, preferNext) : [point.node, point.offset];
      const [anchor, anchorOffset] = resolve(saved.anchor, !saved.backward);
      const [focus, focusOffset] = resolve(saved.focus, saved.backward);
      anchor.parentElement?.closest('details')?.setAttribute('open', '');
      focus.parentElement?.closest('details')?.setAttribute('open', '');
      if (anchor.isConnected && focus.isConnected) selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    }
  }
  const renderedBlocks = new WeakMap();
  function replaceBlocks(element, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const old = new Map([...element.children].map((node, index) => [node.dataset.mdBlock ?? `position:${index}`, node]));
    const diagrams = new Map([...element.querySelectorAll('.markdown-diagram')].map(node => [node.dataset.mdBlock, node]));
    let cursor = element.firstChild;
    for (const [index, fresh] of [...template.content.children].entries()) {
      const previous = old.get(fresh.dataset.mdBlock ?? `position:${index}`);
      const markup = fresh.outerHTML;
      const sameDiagram = previous?.matches('.markdown-diagram') && previous.dataset.diagram === fresh.dataset.diagram;
      // Compare the original render output: preview images, open disclosures,
      // and link errors can legitimately change the live DOM between chunks.
      const node = previous && (sameDiagram || renderedBlocks.get(previous) === markup || previous.isEqualNode(fresh)) ? previous : fresh;
      if (node === fresh) {
        for (const diagram of fresh.querySelectorAll('.markdown-diagram')) {
          const existing = diagrams.get(diagram.dataset.mdBlock);
          if (existing?.dataset.diagram === diagram.dataset.diagram) diagram.replaceWith(existing);
        }
      }
      renderedBlocks.set(node, markup);
      if (node !== cursor) element.insertBefore(node, cursor);
      else cursor = cursor.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }
  function createMarkdownRenderer(element, afterRender) {
    let source = '';
    let frame = null;
    element.classList.add('markdown-body');
    const changed = () => { if (afterRender) afterRender(); };
    element.addEventListener('load', event => { if (event.target.tagName === 'IMG') changed(); }, true);
    element.addEventListener('markdown-layout', changed);
    function cancel() {
      if (frame !== null) global.cancelAnimationFrame(frame);
      frame = null;
    }
    function flush(text, final = true) {
      cancel();
      source = text;
      preserveView(element, () => replaceBlocks(element, render(source, final)));
      changed();
      enhanceDiagrams(element, changed);
    }
    return {
      schedule(text) {
        source = text;
        if (frame === null) frame = global.requestAnimationFrame(() => flush(source, false));
      },
      flush, cancel,
    };
  }
  async function openLink(event) {
    const link = event.target.closest?.('a.markdown-link');
    if (!link || (event.type === 'auxclick' && event.button !== 1)) return;
    event.preventDefault();
    const url = safeUrl(link.getAttribute('href') || '');
    if (!url) return;
    try {
      if (global.__TAURI__) await global.__TAURI__.core.invoke('open_external_url', { url });
      else global.open(url, '_blank', 'noopener,noreferrer');
    } catch (_error) {
      if (link.nextElementSibling?.classList.contains('markdown-link-error')) return;
      const error = document.createElement('span');
      error.className = 'markdown-link-error';
      error.setAttribute('role', 'alert');
      error.textContent = ' Could not open this link. Copy its address and try again.';
      link.after(error);
    }
  }
  document.addEventListener('click', openLink);
  document.addEventListener('auxclick', openLink);
  colorScheme.addEventListener('change', () => {
    for (const element of document.querySelectorAll('.markdown-body')) {
      for (const block of element.querySelectorAll('.markdown-diagram[data-diagram-state="ready"]')) delete block.dataset.diagramState;
      enhanceDiagrams(element, () => element.dispatchEvent(new Event('markdown-layout')));
    }
  });
  global.renderMarkdown = render;
  global.createMarkdownRenderer = createMarkdownRenderer;
  global.escapeHtml = escapeHtml;
})(window);

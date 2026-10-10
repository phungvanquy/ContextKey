// markdown.js — minimal, XSS-safe Markdown → HTML renderer.
//
// Covers the subset the Python tk renderer supported: bold, italic, bold+italic,
// inline code, fenced code blocks, headings (h1–h3), and bullet / ordered lists.
//
// Security: the source is HTML-escaped FIRST, so any raw HTML/script in the
// input (from the model or API) is rendered as inert text, never executed.
// We only emit tags we generate ourselves from Markdown syntax.

(function (global) {
  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Inline spans, applied to already-escaped text.
  // Order matters: code first (so its contents aren't further formatted),
  // then bold+italic, bold, italic.
  function renderInline(escaped) {
    let out = escaped;
    // inline code `...`
    out = out.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`);
    // bold+italic ***...***
    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, (_m, c) => `<strong><em>${c}</em></strong>`);
    // bold **...**
    out = out.replace(/\*\*([^*]+)\*\*/g, (_m, c) => `<strong>${c}</strong>`);
    // italic *...*
    out = out.replace(/\*([^*]+)\*/g, (_m, c) => `<em>${c}</em>`);
    return out;
  }

  // Block-level parse over lines. Returns an HTML string.
  function render(src) {
    const lines = String(src == null ? '' : src).split('\n');
    const html = [];

    let i = 0;
    let listType = null; // 'ul' | 'ol' | null
    let paragraph = [];

    function flushParagraph() {
      if (paragraph.length) {
        html.push('<p>' + renderInline(escapeHtml(paragraph.join(' '))) + '</p>');
        paragraph = [];
      }
    }
    function closeList() {
      if (listType) {
        html.push(listType === 'ul' ? '</ul>' : '</ol>');
        listType = null;
      }
    }

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block ```
      const fence = line.match(/^```(.*)$/);
      if (fence) {
        flushParagraph();
        closeList();
        const body = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // skip closing fence (or EOF)
        html.push('<pre><code>' + escapeHtml(body.join('\n')) + '</code></pre>');
        continue;
      }

      // Heading #, ##, ###
      const heading = line.match(/^(#{1,3})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length;
        html.push(`<h${level}>` + renderInline(escapeHtml(heading[2])) + `</h${level}>`);
        i++;
        continue;
      }

      // Unordered list item
      const uli = line.match(/^\s*[-*+]\s+(.*)$/);
      if (uli) {
        flushParagraph();
        if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
        html.push('<li>' + renderInline(escapeHtml(uli[1])) + '</li>');
        i++;
        continue;
      }

      // Ordered list item
      const oli = line.match(/^\s*\d+\.\s+(.*)$/);
      if (oli) {
        flushParagraph();
        if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
        html.push('<li>' + renderInline(escapeHtml(oli[1])) + '</li>');
        i++;
        continue;
      }

      // Blank line → paragraph / list break
      if (line.trim() === '') {
        flushParagraph();
        closeList();
        i++;
        continue;
      }

      // Otherwise accumulate into a paragraph
      closeList();
      paragraph.push(line.trim());
      i++;
    }

    flushParagraph();
    closeList();
    return html.join('\n');
  }

  // Reparse the accumulated source, not individual deltas: Markdown delimiters
  // can span chunks. Coalesce bursts into one update per browser frame, and
  // flush/cancel before terminal states so a queued frame cannot overwrite them.
  function createMarkdownRenderer(element, afterRender) {
    let source = '';
    let frame = null;

    function cancel() {
      if (frame !== null) global.cancelAnimationFrame(frame);
      frame = null;
    }

    function flush(text) {
      cancel();
      source = text;
      element.innerHTML = render(source);
      if (afterRender) afterRender();
    }

    return {
      schedule(text) {
        source = text;
        if (frame === null) frame = global.requestAnimationFrame(() => flush(source));
      },
      flush,
      cancel,
    };
  }

  global.renderMarkdown = render;
  global.createMarkdownRenderer = createMarkdownRenderer;
  global.escapeHtml = escapeHtml;
})(window);

// popup.js — Translation popup logic
// Listens for Tauri events translate://chunk and translate://done
// Handles Escape and blur-to-close

// Access Tauri 2 APIs from the globally injected object (withGlobalTauri: true)
const { getCurrentWindow } = window.__TAURI__.window;
const { listen, emit } = window.__TAURI__.event;
const { invoke } = window.__TAURI__.core;

// ── Parse query string parameters ─────────────────────────────────────────────
function getParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    original: params.get('original') || '',
    lang: params.get('lang') || 'Vietnamese',
  };
}

// ── Truncate original text to ~120 chars with ellipsis ───────────────────────
function truncate(text, maxLen = 120) {
  if (text.length <= maxLen) return text;
  return text.slice(0, 117) + '…';
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const langName        = document.getElementById('lang-name');
const originalText    = document.getElementById('original-text');
const spinner         = document.getElementById('spinner');
const translationText = document.getElementById('translation-text');
const closeBtn        = document.getElementById('close-btn');
const copyBtn         = document.getElementById('copy-btn');
const copyLabel       = copyBtn.querySelector('.copy-label');
const speakBtn        = document.getElementById('speak-btn');
const resultArea      = document.getElementById('result-area');
const errorBox        = document.getElementById('error-box');
const errorSummary    = document.getElementById('error-summary');
const errorDetails    = document.getElementById('error-details');
const errorDetailText = document.getElementById('error-detail-text');
const retryBtn        = document.getElementById('retry-btn');

// ── Close ─────────────────────────────────────────────────────────────────────
let isClosed = false;

async function closePopup() {
  if (isClosed) return;
  isClosed = true;
  markdownRenderer.cancel();
  invoke('tts_stop').catch(() => {});
  try {
    await getCurrentWindow().close();
  } catch (_e) {
    // window may already be closing
  }
}

// ── Blur-to-close ─────────────────────────────────────────────────────────────
// Close when the user clicks away — but a raw "unfocused" event is NOT proof
// they left. Interactions *inside* the popup drop webview focus on Windows too;
// `data-tauri-drag-region` is the worst offender, since it hands the window to
// the OS move loop (ReleaseCapture + WM_NCLBUTTONDOWN) which reports the
// webview unfocused mid-drag. Closing on that made the popup vanish on a header
// click. Native calls (TTS, clipboard) can flicker focus the same way.
//
// So: ignore blur while a drag is live, and otherwise wait a beat and re-ask
// the window whether it is really unfocused. Focus returns on its own for every
// in-window cause, so only a genuine click elsewhere survives the grace period.
const BLUR_GRACE_MS = 200;
// The move loop can swallow the matching mouseup, so a stuck drag flag would
// kill blur-to-close for the popup's whole life. This bounds it.
const DRAG_BACKSTOP_MS = 5000;

async function installBlurToClose(onBlur) {
  const win = getCurrentWindow();
  let hasFocused = false;
  let dragging = false;
  let closeTimer = null;
  let dragBackstop = null;

  const cancelPendingClose = () => {
    clearTimeout(closeTimer);
    closeTimer = null;
  };

  const endDrag = () => {
    dragging = false;
    clearTimeout(dragBackstop);
    dragBackstop = null;
  };

  document.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest('[data-tauri-drag-region]')) return;
    endDrag();
    dragging = true;
    cancelPendingClose();
    dragBackstop = setTimeout(endDrag, DRAG_BACKSTOP_MS);
  });
  document.addEventListener('mouseup', endDrag);

  await win.onFocusChanged(({ payload: focused }) => {
    if (focused) {
      // Focus came back, so whatever caused the blur was ours.
      hasFocused = true;
      endDrag();
      cancelPendingClose();
      return;
    }
    // Ignore blur until the window has focused once: a window that never
    // grabbed focus would otherwise close instantly.
    if (!hasFocused) return;
    cancelPendingClose();
    closeTimer = setTimeout(async () => {
      closeTimer = null;
      if (dragging) return;
      try {
        if (await win.isFocused()) return;
      } catch (_e) {
        // Query failed (window already going away) — fall through and close.
      }
      onBlur();
    }, BLUR_GRACE_MS);
  });
}

// ── Live resize to content ───────────────────────────────────────────────────
// The window was built from an estimate. As chunks arrive and after Markdown
// rendering the true content height is known — measure and ask the backend to
// grow/shrink to fit, capped to the monitor. Uses the existing window chrome
// size rather than a hardcoded constant, and coalesces rapid chunks.
let lastReportedH = 0;
let resizeTimer = null;
const RESIZE_DEBOUNCE_MS = 120;
function requestResize() {
  if (isClosed) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    if (isClosed) return;
    const h = window.innerHeight - resultArea.clientHeight + resultArea.scrollHeight;
    if (!Number.isFinite(h) || h < 80 || h > 3000) return;
    if (Math.abs(h - lastReportedH) < 12) return;
    lastReportedH = h;
    try { await invoke('resize_translate_popup', { contentLogicalH: h }); } catch (_e) {}
  }, RESIZE_DEBOUNCE_MS);
}

// ── Stream state ──────────────────────────────────────────────────────────────
// Module-scoped because a retry runs a second stream through the same handlers.
let streamStarted = false;
let fullText = '';
let failed = false;
const markdownRenderer = createMarkdownRenderer(translationText, () => {
  translationText.classList.add('rendered');
  requestResize();
});

// Return the popup to its loading state so another stream can render into it.
function resetForStream() {
  markdownRenderer.cancel();
  lastReportedH = 0;
  streamStarted = false;
  fullText = '';
  failed = false;
  errorBox.hidden = true;
  errorDetails.open = false;
  translationText.textContent = '';
  translationText.classList.remove('rendered');
  translationText.style.display = 'none';
  spinner.style.display = 'flex';
  copyBtn.disabled = true;
}

function showError({ summary, detail, retryable }) {
  failed = true;
  if (streamStarted) markdownRenderer.flush(fullText);
  spinner.style.display = 'none';
  errorSummary.textContent = summary;
  errorDetailText.textContent = detail || '';
  errorDetails.hidden = !detail;
  retryBtn.hidden = !retryable;
  errorBox.hidden = false;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const { original, lang } = getParams();

  langName.textContent = lang;
  originalText.textContent = truncate(original);
  originalText.title = original; // full untruncated text on hover

  // Listeners live for the popup's lifetime: a retry streams through them again.
  await listen('translate://chunk', (event) => {
    if (failed || isClosed) return;
    if (!streamStarted) {
      // Hide spinner, show text area on first chunk
      spinner.style.display = 'none';
      translationText.style.display = 'block';
      streamStarted = true;
    }
    // Preserve the source for Copy and reparse it as Markdown while streaming.
    fullText += event.payload;
    markdownRenderer.schedule(fullText);
  });

  await listen('translate://error', (event) => { showError(event.payload); requestResize(); });

  await listen('translate://done', () => {
    // A failed request already rendered its own state; leave it alone.
    if (failed || isClosed) return;
    if (!streamStarted) {
      spinner.style.display = 'none';
      translationText.style.display = 'block';
    }
    // Flush even when the final chunk and completion arrive in the same frame.
    markdownRenderer.flush(fullText);
    if (fullText.trim()) copyBtn.disabled = false;
    requestAnimationFrame(requestResize);
  });

  retryBtn.addEventListener('click', () => {
    resetForStream();
    invoke('translate_retry', { text: original }).catch((e) =>
      showError({ summary: 'Could not start the retry.', detail: String(e), retryable: true })
    );
  });

  // Copy the raw accumulated translation (not rendered HTML) to the clipboard.
  let copyResetTimer = null;
  const copyIcon = copyBtn.querySelector('use');
  copyBtn.addEventListener('click', async () => {
    if (copyBtn.disabled) return;
    try {
      await navigator.clipboard.writeText(fullText);
      copyBtn.classList.remove('copy-error');
      copyBtn.classList.add('copied');
      copyLabel.textContent = 'Copied';
      copyIcon.setAttribute('href', '#ic-check');
    } catch (_e) {
      copyBtn.classList.remove('copied');
      copyBtn.classList.add('copy-error');
      copyLabel.textContent = 'Copy failed';
    }
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      copyBtn.classList.remove('copied', 'copy-error');
      copyLabel.textContent = 'Copy';
      copyIcon.setAttribute('href', '#ic-copy');
    }, 1200);
  });

  // Speak source text aloud
  speakBtn.addEventListener('click', () => {
    invoke('tts_speak', { text: original });
  });

  // Escape to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopup();
    }
  });

  // Click outside to close (see installBlurToClose for why this isn't just
  // "close on unfocused").
  await installBlurToClose(closePopup);

  // Close button
  closeBtn.addEventListener('click', () => closePopup());

  // Signal the backend that our listeners are attached and it may start
  // streaming. Tauri events are not buffered, so the backend waits for this
  // before emitting translate://chunk (see handle_translate_trigger).
  await emit('popup://ready');
}

init().catch(console.error);

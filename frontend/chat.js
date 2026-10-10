// Chat history and pending attachments belong to this window. The backend
// receives only the history for the turn being answered, including on retry.
const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;
const { listen, emit } = window.__TAURI__.event;

const byId = id => document.getElementById(id);
const headerLabel = byId('header-label');
const contextStrip = byId('context-strip');
const contextClear = byId('context-clear');
const transcript = byId('transcript');
const chatInput = byId('chat-input');
const sendBtn = byId('send-btn');
const newChatBtn = byId('new-chat-btn');
const emptyState = byId('empty-state');
const jumpLatest = byId('jump-latest');
const imageStrip = byId('image-strip');
const imageDialog = byId('image-dialog');
const resetDialog = byId('reset-dialog');

const MAX_IMAGES = 2;
const IMAGE_REMOVED = '[earlier screenshot removed from context]';
let selectedText = '';
let history = [];
let pendingImages = [];
let sessionImages = [];
let nextImageId = 1;
let pendingSelection = null;
let currentTurn = null;
let streaming = false;
let ready = false;
let isClosed = false;
let followLatest = true;
let resetAction = null;
const failedTurns = new Set();

function announce(message) {
  byId('chat-status').textContent = message;
}

async function closePopup() {
  if (isClosed) return;
  isClosed = true;
  try { await emit('chat://closed', {}); } catch (_e) { /* close still works */ }
  try { await getCurrentWindow().close(); } catch (_e) { isClosed = false; }
}

function updateControls() {
  sendBtn.disabled = !ready || streaming || !chatInput.value.trim();
  sendBtn.textContent = streaming ? 'Replying…' : 'Send';
  newChatBtn.disabled = streaming;
  contextClear.disabled = streaming;
  byId('use-selection-btn').disabled = streaming;
  transcript.setAttribute('aria-busy', String(streaming));
  for (const turn of failedTurns) {
    if (!history.includes(turn.userMessage)) {
      turn.retry.remove();
      failedTurns.delete(turn);
    } else {
      turn.retry.disabled = streaming;
    }
  }
}

function updateContext() {
  contextStrip.hidden = !selectedText.trim();
  byId('context-text').textContent = selectedText.length > 140 ? selectedText.slice(0, 137) + '…' : selectedText;
  byId('context-full').textContent = selectedText;
  headerLabel.textContent = selectedText.trim() || sessionImages.length ? 'Chat' : 'Free Chat';
  emptyState.hidden = history.length > 0;
  byId('empty-title').textContent = pendingImages.length ? 'Ask about your screenshot' : selectedText.trim() ? 'Ask about this selection' : 'Start a conversation';
  byId('empty-description').textContent = pendingImages.length
    ? 'Preview or remove a screenshot below, then type a question to send it.'
    : 'Type a question below. Shift+Enter adds a new line.';
}

function updateJumpButton() {
  jumpLatest.hidden = followLatest || transcript.scrollHeight <= transcript.clientHeight;
}

function scrollToBottom(force = false) {
  if (force) followLatest = true;
  if (followLatest) transcript.scrollTop = transcript.scrollHeight;
  updateJumpButton();
}

function autoGrow() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  scrollToBottom();
}

function resetChat(context, preserveDraft) {
  if (streaming) return;
  selectedText = context;
  history = [];
  pendingImages = [];
  sessionImages = [];
  failedTurns.clear();
  pendingSelection = null;
  byId('selection-notice').hidden = true;
  contextStrip.querySelector('details').open = false;
  transcript.replaceChildren(emptyState);
  if (!preserveDraft) chatInput.value = '';
  autoGrow();
  renderPendingImages();
  updateControls();
  scrollToBottom(true);
  announce('New chat started. Previous messages and screenshots were cleared.');
  chatInput.focus();
}

function requestReset(context = '', preserveDraft = false) {
  if (streaming) return;
  if (!history.length && !pendingImages.length && (preserveDraft || !chatInput.value.trim())) {
    resetChat(context, preserveDraft);
    return;
  }
  resetAction = () => resetChat(context, preserveDraft);
  byId('reset-description').textContent = preserveDraft
    ? 'This clears the selected text, conversation, and screenshots. Your unsent message stays in the input.'
    : 'This clears the current conversation, screenshots, and unsent message.';
  resetDialog.showModal();
}

function addUserMessage(text, images) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  if (images.length) {
    const attachments = document.createElement('div');
    attachments.className = 'message-images';
    for (const image of images) attachments.appendChild(imageButton(image));
    el.appendChild(attachments);
  }
  const body = document.createElement('div');
  body.textContent = text;
  el.appendChild(body);
  transcript.appendChild(el);
  emptyState.hidden = true;
  scrollToBottom(true);
}

async function send() {
  const question = chatInput.value.trim();
  if (!ready || !question || streaming) return;
  announce('');
  const images = pendingImages;
  // Consume only this message's attachments now. Captures arriving during the
  // response belong to the next message and must survive completion or failure.
  pendingImages = [];
  const content = images.length
    ? [{ type: 'text', text: question }, ...images.map(image => ({ type: 'image_url', image_url: { url: image.url } }))]
    : question;
  const userMessage = { role: 'user', content };
  history.push(userMessage);
  chatInput.value = '';
  chatInput.style.height = '';
  addUserMessage(question, images);
  renderPendingImages();
  const turn = beginTurn(userMessage);
  chatInput.focus();
  await runTurn(turn);
}

function beginTurn(userMessage, existingBubble) {
  const aiEl = existingBubble || document.createElement('div');
  aiEl.className = 'msg msg-ai is-streaming';
  aiEl.innerHTML = '<span class="typing" aria-label="Waiting for a reply"><span></span><span></span><span></span></span>';
  if (!existingBubble) transcript.appendChild(aiEl);
  let full = '';
  const markdownRenderer = createMarkdownRenderer(aiEl, scrollToBottom);
  streaming = true;
  updateControls();
  scrollToBottom();

  const turn = {
    userMessage,
    el: aiEl,
    failed: false,
    release() {
      if (currentTurn !== this) return;
      markdownRenderer.cancel();
      currentTurn = null;
      streaming = false;
      aiEl.classList.remove('is-streaming');
      updateControls();
      updateContext();
    },
    appendInterim(delta) {
      if (this.failed) return;
      full += delta;
      markdownRenderer.schedule(full);
    },
    fail(error) {
      if (this.failed) return;
      this.failed = true;
      markdownRenderer.cancel();
      aiEl.classList.remove('is-streaming');
      aiEl.classList.add('msg-error');
      aiEl.replaceChildren();
      if (full.trim()) {
        const partial = document.createElement('div');
        partial.className = 'partial-response';
        partial.innerHTML = renderMarkdown(full);
        aiEl.appendChild(partial);
      }
      aiEl.appendChild(buildErrorNode(error, this));
      scrollToBottom();
      // The backend emits done after error. Keep this turn attached until then
      // so that terminal event cannot finish a newly submitted request.
    },
    finish() {
      if (!this.failed) {
        if (!full.trim()) {
          this.fail({ summary: 'The model returned an empty reply. Try again.', retryable: true });
        } else {
          markdownRenderer.flush(full);
          const index = history.indexOf(userMessage);
          if (index >= 0) history.splice(index + 1, 0, { role: 'assistant', content: full.trim() });
          if (history.length > 50) history = history.slice(-50);
          pruneImages();
        }
      }
      this.release();
      scrollToBottom();
    },
  };
  currentTurn = turn;
  return turn;
}

async function runTurn(turn) {
  const index = history.indexOf(turn.userMessage);
  if (index < 0) { turn.release(); return; }
  try {
    // Retrying an older failure uses that question's prefix, and replaces its
    // own bubble. Later questions and their replies stay in the conversation.
    await invoke('chat_send', { selectedText, history: history.slice(0, index + 1) });
  } catch (error) {
    if (currentTurn !== turn) return;
    turn.fail({ summary: 'Could not start the request.', detail: String(error), retryable: true });
    turn.release();
  }
}

function buildErrorNode({ summary, detail, retryable }, turn) {
  const box = document.createElement('div');
  box.className = 'error-box';
  const summaryEl = document.createElement('p');
  summaryEl.className = 'error-summary';
  summaryEl.textContent = summary;
  box.appendChild(summaryEl);
  if (detail) {
    const details = document.createElement('details');
    details.className = 'error-details';
    const toggle = document.createElement('summary');
    toggle.className = 'error-details-toggle';
    toggle.textContent = 'Details';
    const pre = document.createElement('pre');
    pre.className = 'error-detail-text';
    pre.textContent = detail;
    details.append(toggle, pre);
    box.appendChild(details);
  }
  if (retryable) {
    const retry = document.createElement('button');
    retry.className = 'btn-retry';
    retry.textContent = 'Retry';
    retry.disabled = streaming;
    turn.retry = retry;
    failedTurns.add(turn);
    retry.addEventListener('click', () => {
      if (streaming || !history.includes(turn.userMessage)) return;
      failedTurns.delete(turn);
      const attempt = beginTurn(turn.userMessage, turn.el);
      runTurn(attempt);
    });
    box.appendChild(retry);
  }
  return box;
}

function imageButton(image) {
  const button = document.createElement('button');
  button.className = 'image-preview-button';
  button.dataset.imageId = image.id;
  button.setAttribute('aria-label', `Preview screenshot ${image.id}`);
  const thumb = document.createElement('img');
  thumb.className = 'image-thumb';
  thumb.src = image.url;
  thumb.alt = `Screenshot ${image.id}`;
  button.appendChild(thumb);
  button.addEventListener('click', () => {
    byId('preview-image').src = image.url;
    imageDialog.dataset.imageId = image.id;
    byId('image-preview').classList.remove('actual-size');
    byId('image-size-btn').textContent = 'Show actual size';
    byId('image-size-btn').setAttribute('aria-pressed', 'false');
    imageDialog.showModal();
  });
  return button;
}

function evictImage(image) {
  sessionImages = sessionImages.filter(item => item !== image);
  pendingImages = pendingImages.filter(item => item !== image);
  for (const message of history) {
    if (Array.isArray(message.content)) {
      message.content = message.content.map(part => part.type === 'image_url' && part.image_url.url === image.url
        ? { type: 'text', text: IMAGE_REMOVED } : part);
    }
  }
  document.querySelectorAll(`[data-image-id="${image.id}"].image-preview-button`).forEach(button => {
    const placeholder = document.createElement('span');
    placeholder.className = 'attachment-removed';
    placeholder.textContent = IMAGE_REMOVED;
    button.replaceWith(placeholder);
  });
  if (imageDialog.open && imageDialog.dataset.imageId === String(image.id)) imageDialog.close();
}

function pruneImages() {
  const usedUrls = new Set(pendingImages.map(image => image.url));
  for (const message of history) {
    if (Array.isArray(message.content)) {
      for (const part of message.content) if (part.type === 'image_url') usedUrls.add(part.image_url.url);
    }
  }
  for (const image of [...sessionImages]) if (!usedUrls.has(image.url)) evictImage(image);
}

function attachImage(url) {
  let image = sessionImages.find(item => item.url === url);
  let evicted = false;
  if (!image) {
    if (sessionImages.length >= MAX_IMAGES) {
      evictImage(sessionImages[0]);
      evicted = true;
    }
    image = { id: nextImageId++, url };
    sessionImages.push(image);
  }
  if (!pendingImages.includes(image)) pendingImages.push(image);
  renderPendingImages();
  announce(evicted ? 'Oldest screenshot removed from context. Up to two screenshots are kept.' : 'Screenshot attached. Send a question when you are ready.');
}

function renderPendingImages() {
  imageStrip.replaceChildren();
  imageStrip.hidden = !pendingImages.length;
  for (const image of pendingImages) {
    const card = document.createElement('div');
    card.className = 'attachment-card';
    card.appendChild(imageButton(image));
    const remove = document.createElement('button');
    remove.className = 'attachment-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove screenshot ${image.id}`);
    remove.addEventListener('click', () => {
      pendingImages = pendingImages.filter(item => item !== image);
      pruneImages();
      renderPendingImages();
      announce('Screenshot removed from the next message.');
      chatInput.focus();
    });
    card.appendChild(remove);
    imageStrip.appendChild(card);
  }
  updateContext();
  scrollToBottom();
}

async function takeSelection() {
  try {
    const selection = await invoke('take_pending_chat_selection');
    if (selection == null || selection === selectedText) return;
    pendingSelection = selection;
    byId('selection-notice').hidden = false;
  } catch (error) {
    console.error('Could not load the new selection', error);
  }
}

async function takeImage() {
  try {
    const pending = await invoke('take_pending_image');
    if (pending) attachImage(pending);
  } catch (_error) {
    announce('Could not load the screenshot. Capture it again to attach it.');
  }
}

async function init() {
  selectedText = new URLSearchParams(window.location.search).get('selected') || '';
  updateContext();

  // Controls are wired before awaiting backend calls so close and keyboard
  // navigation remain available even if an initial payload fails to load.
  byId('close-btn').addEventListener('click', closePopup);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]') && !event.isComposing) closePopup();
  });
  newChatBtn.addEventListener('click', () => requestReset());
  contextClear.addEventListener('click', () => requestReset('', true));
  byId('confirm-reset-btn').addEventListener('click', () => {
    resetDialog.close();
    resetAction?.();
    resetAction = null;
  });
  byId('cancel-reset-btn').addEventListener('click', () => resetDialog.close());
  byId('use-selection-btn').addEventListener('click', () => requestReset(pendingSelection || ''));
  byId('dismiss-selection-btn').addEventListener('click', () => {
    pendingSelection = null;
    byId('selection-notice').hidden = true;
  });
  byId('close-image-btn').addEventListener('click', () => imageDialog.close());
  imageDialog.addEventListener('close', () => byId('preview-image').removeAttribute('src'));
  byId('image-size-btn').addEventListener('click', event => {
    const actual = byId('image-preview').classList.toggle('actual-size');
    event.currentTarget.textContent = actual ? 'Fit to window' : 'Show actual size';
    event.currentTarget.setAttribute('aria-pressed', String(actual));
  });
  transcript.addEventListener('scroll', () => {
    followLatest = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
    updateJumpButton();
  });
  jumpLatest.addEventListener('click', () => scrollToBottom(true));
  new ResizeObserver(() => scrollToBottom()).observe(transcript);
  chatInput.addEventListener('input', () => { autoGrow(); updateControls(); });
  chatInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
    if (event.shiftKey && !event.ctrlKey) return;
    event.preventDefault();
    send();
  });

  await listen('chat://chunk', event => currentTurn?.appendInterim(event.payload));
  await listen('chat://error', event => currentTurn?.fail(event.payload));
  await listen('chat://done', () => currentTurn?.finish());
  await listen('chat://attach-image', event => attachImage(event.payload));
  await listen('chat://image-available', takeImage);
  await listen('chat://selection-available', takeSelection);
  await takeSelection();
  await takeImage();
  sendBtn.addEventListener('click', send);
  ready = true;
  updateControls();
  chatInput.focus();
}

init().catch(error => {
  announce('Chat could not start. Close this window and try again.');
  console.error(error);
});

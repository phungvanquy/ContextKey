// icons.js — Shared inline SVG icon sprite.
// Single source of truth for all UI glyphs (replaces emoji). Injects a hidden
// <symbol> sprite at the top of <body>; reference an icon with:
//   <svg class="ic"><use href="#ic-close"/></svg>
// Strokes use currentColor (see .ic in theme.css) so icons tint per theme.
// Paths adapted from the MIT-licensed Lucide icon set (24x24 viewBox).
//
// This script is included as the FIRST element inside <body> so the sprite is
// present before the markup that references it renders.
(function () {
  var SPRITE = [
    '<svg class="ic-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">',
    // close (x)
    '<symbol id="ic-close" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>',
    // arrow-right (language direction)
    '<symbol id="ic-arrow-right" viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></symbol>',
    // chat bubble
    '<symbol id="ic-chat" viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></symbol>',
    // spinner (3/4 ring — spun via .ic-spin)
    '<symbol id="ic-spinner" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></symbol>',
    // volume (TTS)
    '<symbol id="ic-volume" viewBox="0 0 24 24"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/></symbol>',
    // copy (two stacked cards)
    '<symbol id="ic-copy" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></symbol>',
    // check (copied confirmation)
    '<symbol id="ic-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>',
    // refresh / reset (rotate)
    '<symbol id="ic-refresh" viewBox="0 0 24 24"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></symbol>',
    '<symbol id="ic-plug" viewBox="0 0 24 24"><path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0V8ZM12 16v5"/></symbol>',
    '<symbol id="ic-languages" viewBox="0 0 24 24"><path d="M3 5h12M9 3v2M6 5c1 5 4 8 8 10M12 5c-1 5-4 8-9 11M13 21l4-10 4 10M14.5 17h5"/></symbol>',
    '<symbol id="ic-keyboard" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/></symbol>',
    '<symbol id="ic-scan" viewBox="0 0 24 24"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/><rect x="7" y="7" width="10" height="10" rx="1"/></symbol>',
    '<symbol id="ic-sliders" viewBox="0 0 24 24"><path d="M4 7h8M16 7h4M4 17h4M12 17h8"/><circle cx="14" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></symbol>',
    '<symbol id="ic-eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></symbol>',
    '<symbol id="ic-eye-off" viewBox="0 0 24 24"><path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.9M6.5 6.5A19 19 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 5.5-1.5M10 10a3 3 0 0 0 4 4"/></symbol>',
    '<symbol id="ic-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>',
    '<symbol id="ic-arrow-up" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></symbol>',
    '<symbol id="ic-text" viewBox="0 0 24 24"><path d="M4 6h16M4 10h16M4 14h10M4 18h7"/></symbol>',
    '</svg>',
  ].join('');

  function inject() {
    if (document.getElementById('ic-sprite-root')) return;
    var holder = document.createElement('div');
    holder.id = 'ic-sprite-root';
    holder.style.display = 'none';
    holder.innerHTML = SPRITE;
    document.body.insertBefore(holder, document.body.firstChild);
  }

  if (document.body) {
    inject();
  } else {
    document.addEventListener('DOMContentLoaded', inject);
  }
})();

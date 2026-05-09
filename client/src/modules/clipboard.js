'use strict';
window.ClipboardModule = (() => {

  function $hist() { return document.getElementById('clipboard-history'); }
  function esc(s)  { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function _copyToClipboard(text, btn) {
    const done = () => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    };
    const fail = () => {
      /* textarea fallback — works on http */
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) done(); else UI.toast('Copy failed — select text manually', 'error');
      } catch { UI.toast('Copy not available', 'error'); }
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fail);
    } else {
      fail();
    }
  }

  function addItem(text, dir, time) {
    const t   = time ? new Date(time) : new Date();
    const ts  = t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    const lbl = dir === 'in' ? '↓ Received' : '↑ Sent';

    /* Build DOM manually — no innerHTML for the copy button
       so the event listener is never destroyed                */
    const el   = document.createElement('div');
    el.className = `clip-item ci-${dir}`;

    const txtDiv  = document.createElement('div');
    txtDiv.className = 'ci-txt';
    txtDiv.textContent = text;           // textContent — safe, no XSS

    const sideDiv = document.createElement('div');
    sideDiv.className = 'ci-side';

    const meta = document.createElement('span');
    meta.className = 'ci-meta';
    meta.textContent = `${lbl} · ${ts}`;

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-cpcopy';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => _copyToClipboard(text, copyBtn));

    sideDiv.appendChild(meta);
    sideDiv.appendChild(copyBtn);
    el.appendChild(txtDiv);
    el.appendChild(sideDiv);

    $hist().prepend(el);
  }

  function send(text) {
    if (!text) return;
    if (!Channels.isOpen(Channels.LABELS.CLIPBOARD)) {
      UI.toast('Not connected yet', 'error'); return;
    }
    const payload = { type:'clip', text, time:Date.now() };
    const sent = Channels.broadcastJSON(Channels.LABELS.CLIPBOARD, payload) ||
                 Channels.sendJSON(Channels.LABELS.CLIPBOARD, payload);
    if (sent) { addItem(text, 'out'); UI.toast('Clipboard sent ✓'); }
  }

  async function readAndSend() {
    if (!navigator.clipboard?.readText) {
      UI.toast('Clipboard unavailable on HTTP — paste in the box below', 'error'); return;
    }
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { UI.toast('Clipboard is empty'); return; }
      send(t);
    } catch(e) {
      UI.toast('Clipboard access denied — paste in the box below', 'error');
    }
  }

  function init() {
    Channels.onMessage(Channels.LABELS.CLIPBOARD, (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'clip') {
        addItem(msg.text, 'in', msg.time);
        if (document.hasFocus() && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(msg.text).catch(()=>{});
        }
        UI.toast('Clipboard received');
      }
    });

    document.getElementById('btn-send-clip').addEventListener('click', readAndSend);

    document.getElementById('btn-read-clip').addEventListener('click', async () => {
      if (!navigator.clipboard?.readText) {
        UI.toast('Clipboard unavailable on HTTP', 'error'); return;
      }
      try {
        document.getElementById('clip-input').value = await navigator.clipboard.readText();
      } catch { UI.toast('Clipboard access denied', 'error'); }
    });

    document.getElementById('btn-send-clip-text').addEventListener('click', () => {
      const t = document.getElementById('clip-input').value.trim();
      if (t) { send(t); document.getElementById('clip-input').value = ''; }
    });
  }

  return { init, send };
})();

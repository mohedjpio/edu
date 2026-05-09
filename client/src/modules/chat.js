'use strict';
window.ChatModule = (() => {

  let _getMode, _getMyName, _getPeerNames;
  let _typTimer   = null;
  let _isTyping   = false;
  let _replyTo    = null;   // { id, text, sender } — currently quoted message
  let _msgs       = {};     // msgId → DOM element (for seen ticks)
  let _recorder   = null;   // MediaRecorder instance
  let _recChunks  = [];
  let _recTimer   = null;
  let _recSecs    = 0;
  let _recording  = false;

  /* ── Context menu state ── */
  let _ctxMenu    = null;   // current context menu DOM element
  let _ctxMsgEl   = null;   // message element the menu is anchored to
  let _longTimer  = null;   // long-press timer handle
  const REACTIONS = ['👍','❤️','😂','😮','😢','🔥','👏','🎉'];

  /* ── helpers ── */
  const $msgs  = () => document.getElementById('chat-messages');
  const $input = () => document.getElementById('chat-input');
  const genId  = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  }
  function _senderName(pid) {
    if (!pid) return _getMyName ? _getMyName() : 'You';
    return (_getPeerNames?.()[pid]) || 'Peer';
  }
  function _send(payload) {
    const mode = _getMode?.() || 'p2p';
    if (mode === 'group') Channels.broadcastJSON(Channels.LABELS.CHAT, payload);
    else                  Channels.sendJSON(Channels.LABELS.CHAT, payload);
  }
  function _scrollBottom() {
    const el = $msgs();
    if (el) el.scrollTop = el.scrollHeight;
  }

  /* ════════════════════════════════════════════════════════════
     BUILD MESSAGE ELEMENT
  ════════════════════════════════════════════════════════════ */
  function _buildMsg({ id, dir, text, time, fromPeerId, replyTo, audioUrl, audioDur, isGroup }) {
    const el = document.createElement('div');
    el.className = `msg msg-${dir}`;
    el.dataset.msgId = id;
    if (dir === 'sys') { el.textContent = text; return el; }

    const ts = fmtTime(time);

    // ── Reply quote ──
    let replyHTML = '';
    if (replyTo) {
      replyHTML = `<div class="msg-reply-quote" data-reply-id="${esc(replyTo.id)}">
        <span class="msg-reply-sender">${esc(replyTo.sender)}</span>
        <span class="msg-reply-text">${esc((replyTo.text||'🎤 Voice note').slice(0,80))}</span>
      </div>`;
    }

    // ── Sender name (group in-message) ──
    const senderHTML = (dir === 'in' && isGroup)
      ? `<div class="msg-sender">${esc(_senderName(fromPeerId))}</div>` : '';

    // ── Body ──
    let bodyHTML = '';
    if (audioUrl) {
      bodyHTML = `<div class="msg-voice">
        <button class="voice-play-btn" data-audio="${audioUrl}">
          <svg class="voice-icon-play" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          <svg class="voice-icon-pause hidden" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        </button>
        <div class="voice-body">
          <div class="voice-waveform">${_makeWave()}</div>
          <span class="voice-dur">${audioDur || '0:00'}</span>
        </div>
      </div>`;
    } else {
      bodyHTML = `<div class="msg-text">${esc(text)}</div>`;
    }

    // ── Meta (time + ticks) ──
    const ticksHTML = dir === 'out'
      ? `<span class="msg-ticks" data-state="sent">
          <svg class="tick-icon" width="14" height="9" viewBox="0 0 16 10" fill="none">
            <path d="M1 5l4 4L15 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </span>` : '';

    el.innerHTML = `
      <button class="msg-reply-btn" title="Reply" aria-label="Reply">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
      </button>
      <div class="msg-inner">
        ${senderHTML}
        ${replyHTML}
        ${bodyHTML}
        <div class="msg-meta">
          <span class="msg-time">${ts}</span>
          ${ticksHTML}
        </div>
      </div>`;

    // Wire reply button
    el.querySelector('.msg-reply-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      _setReply({
        id,
        text: text || '🎤 Voice note',
        sender: dir === 'out' ? (_getMyName?.() || 'You') : _senderName(fromPeerId),
      });
    });

    // Wire reply quote tap — scroll to original message
    el.querySelector('.msg-reply-quote')?.addEventListener('click', () => {
      const orig = _msgs[replyTo?.id];
      if (orig) {
        orig.scrollIntoView({ behavior:'smooth', block:'center' });
        orig.classList.add('msg-highlight');
        setTimeout(() => orig.classList.remove('msg-highlight'), 1200);
      }
    });

    // Right-click / long-press context menu
    const _openCtx = (e) => {
      e.preventDefault();
      _showContextMenu(el, id, text || '🎤 Voice note', dir, fromPeerId);
    };
    el.addEventListener('contextmenu', _openCtx);
    // Long-press for mobile
    let _lpTimer;
    el.addEventListener('touchstart', () => { _lpTimer = setTimeout(() => _openCtx({ preventDefault:()=>{} }), 500); }, { passive: true });
    el.addEventListener('touchend',   () => clearTimeout(_lpTimer));
    el.addEventListener('touchmove',  () => clearTimeout(_lpTimer));

    // Wire voice play
    if (audioUrl) {
      el.querySelector('.voice-play-btn')?.addEventListener('click', function() {
        _playVoice(this, audioUrl, el);
      });
    }

    // ── Right-click context menu (desktop) ──
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      _showCtxMenu(el, e.clientX, e.clientY, { id, dir, text, audioUrl });
    });

    // ── Long-press context menu (mobile) ──
    el.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) return;
      _longTimer = setTimeout(() => {
        const t = e.touches[0];
        _showCtxMenu(el, t.clientX, t.clientY, { id, dir, text, audioUrl });
      }, 500);
    }, { passive: true });
    el.addEventListener('touchend',    () => clearTimeout(_longTimer));
    el.addEventListener('touchmove',   () => clearTimeout(_longTimer));
    el.addEventListener('touchcancel', () => clearTimeout(_longTimer));

    return el;
  }

  function _makeWave() {
    // Generate a random waveform of 28 bars
    return Array.from({length:28}, (_,i) => {
      const h = 4 + Math.round(Math.random() * 14);
      return `<span class="wv-bar" style="height:${h}px"></span>`;
    }).join('');
  }

  /* ── Active audio player state ── */
  let _activeAudio = null;
  let _activeBtn   = null;

  function _playVoice(btn, url, msgEl) {
    // Stop previous
    if (_activeAudio && !_activeAudio.paused) {
      _activeAudio.pause();
      _activeBtn?.querySelector('.voice-icon-play').classList.remove('hidden');
      _activeBtn?.querySelector('.voice-icon-pause').classList.add('hidden');
      if (_activeBtn === btn) { _activeAudio = null; _activeBtn = null; return; }
    }
    const audio = new Audio(url);
    _activeAudio = audio;
    _activeBtn   = btn;
    btn.querySelector('.voice-icon-play').classList.add('hidden');
    btn.querySelector('.voice-icon-pause').classList.remove('hidden');

    // Animate waveform
    const bars = msgEl.querySelectorAll('.wv-bar');
    let animFrame;
    function animateBars() {
      if (audio.paused || audio.ended) return;
      bars.forEach(b => {
        const h = 4 + Math.round(Math.random()*14);
        b.style.height = h+'px';
      });
      animFrame = requestAnimationFrame(animateBars);
    }
    audio.play();
    animateBars();

    audio.onended = () => {
      cancelAnimationFrame(animFrame);
      btn.querySelector('.voice-icon-play').classList.remove('hidden');
      btn.querySelector('.voice-icon-pause').classList.add('hidden');
      _activeAudio = null; _activeBtn = null;
    };
    audio.onerror = () => { UI.toast('Could not play voice note','error'); };
  }

  /* ════════════════════════════════════════════════════════════
     CONTEXT MENU  (right-click / long-press)
  ════════════════════════════════════════════════════════════ */

  function _hideCtxMenu() {
    if (_ctxMenu) {
      _ctxMenu.classList.add('ctx-hiding');
      setTimeout(() => { _ctxMenu?.remove(); _ctxMenu = null; _ctxMsgEl = null; }, 180);
    }
  }

  function _showCtxMenu(msgEl, cx, cy, { id, dir, text, audioUrl }) {
    _hideCtxMenu();

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    _ctxMenu   = menu;
    _ctxMsgEl  = msgEl;

    // ── Emoji reaction row ──
    const reactionRow = document.createElement('div');
    reactionRow.className = 'ctx-reactions';
    REACTIONS.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'ctx-reaction-btn';
      btn.textContent = emoji;
      // Show if already reacted
      const existing = msgEl.querySelector(`.msg-reaction[data-emoji="${emoji}"]`);
      if (existing) btn.classList.add('reacted');
      btn.addEventListener('click', () => {
        _toggleReaction(msgEl, id, emoji);
        _hideCtxMenu();
      });
      reactionRow.appendChild(btn);
    });
    menu.appendChild(reactionRow);

    // ── Divider ──
    const div = document.createElement('div');
    div.className = 'ctx-divider';
    menu.appendChild(div);

    // ── Action items ──
    const actions = [
      { icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`,
        label: 'Reply', fn: () => {
          _setReply({ id, text: text || '🎤 Voice note', sender: dir === 'out' ? (_getMyName?.() || 'You') : _senderName(_ctxMsgEl?.dataset?.from) });
          _hideCtxMenu();
        }
      },
      { icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
        label: 'Copy', fn: () => {
          if (text) {
            navigator.clipboard?.writeText(text).then(() => UI.toast('Copied')).catch(() => UI.toast('Copy failed','error'));
          }
          _hideCtxMenu();
        },
        hidden: !!audioUrl
      },
      { icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
        label: 'Forward', fn: () => {
          if (text) { if($input()) $input().value = text; }
          _hideCtxMenu(); UI.toast('Message forwarded to input');
        },
        hidden: !!audioUrl
      },
      { icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`,
        label: 'Delete', danger: true, fn: () => {
          msgEl.style.transition = 'opacity .2s, transform .2s';
          msgEl.style.opacity = '0'; msgEl.style.transform = 'scale(.9)';
          setTimeout(() => msgEl.remove(), 200);
          _hideCtxMenu();
        },
        hidden: dir !== 'out'
      },
    ];

    actions.filter(a => !a.hidden).forEach(a => {
      const btn = document.createElement('button');
      btn.className = 'ctx-action' + (a.danger ? ' ctx-action-danger' : '');
      btn.innerHTML = a.icon + `<span>${a.label}</span>`;
      btn.addEventListener('click', a.fn);
      menu.appendChild(btn);
    });

    // ── Position ──
    document.body.appendChild(menu);
    const mw = menu.offsetWidth  || 200;
    const mh = menu.offsetHeight || 220;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = cx, y = cy;
    if (x + mw > vw - 8)  x = vw - mw - 8;
    if (x < 8)            x = 8;
    if (y + mh > vh - 8)  y = cy - mh;
    if (y < 8)            y = 8;
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';

    // Store sender info on element
    msgEl.dataset.from = msgEl.dataset.from || '';

    // Click outside closes
    requestAnimationFrame(() => {
      document.addEventListener('click',      _hideCtxMenu, { once: true });
      document.addEventListener('contextmenu', _hideCtxMenu, { once: true });
    });
  }

  /* ── Reactions ── */
  function _toggleReaction(msgEl, msgId, emoji) {
    // Find existing reaction bar or create
    let bar = msgEl.querySelector('.msg-reactions');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'msg-reactions';
      msgEl.appendChild(bar);
    }

    const existing = bar.querySelector(`.msg-reaction[data-emoji="${emoji}"]`);
    if (existing) {
      // Toggle off
      const cnt = parseInt(existing.dataset.count||'1') - 1;
      if (cnt <= 0) existing.remove();
      else { existing.dataset.count = cnt; existing.querySelector('.rxn-count').textContent = cnt; }
    } else {
      // Add
      const rxn = document.createElement('div');
      rxn.className = 'msg-reaction';
      rxn.dataset.emoji = emoji;
      rxn.dataset.count = '1';
      rxn.innerHTML = `<span class="rxn-emoji">${emoji}</span><span class="rxn-count">1</span>`;
      rxn.addEventListener('click', () => _toggleReaction(msgEl, msgId, emoji));
      bar.appendChild(rxn);
      // Animate
      rxn.style.animation = 'rxn-pop .25s var(--ease)';
    }

    // Broadcast reaction to peers
    _send({ type:'reaction', msgId, emoji, action: existing ? 'remove' : 'add' });

    if (bar.children.length === 0) bar.remove();
  }

  function _applyRemoteReaction(msgId, emoji, action) {
    // Find the message element
    const msgEl = _msgs[msgId];
    if (!msgEl) return;
    let bar = msgEl.querySelector('.msg-reactions');
    if (!bar && action === 'remove') return;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'msg-reactions';
      msgEl.appendChild(bar);
    }
    const existing = bar.querySelector(`.msg-reaction[data-emoji="${emoji}"]`);
    if (action === 'remove') {
      if (!existing) return;
      const cnt = parseInt(existing.dataset.count||'1') - 1;
      if (cnt <= 0) existing.remove();
      else { existing.dataset.count = cnt; existing.querySelector('.rxn-count').textContent = cnt; }
    } else {
      if (existing) {
        const cnt = parseInt(existing.dataset.count||'1') + 1;
        existing.dataset.count = cnt;
        existing.querySelector('.rxn-count').textContent = cnt;
      } else {
        const rxn = document.createElement('div');
        rxn.className = 'msg-reaction';
        rxn.dataset.emoji = emoji;
        rxn.dataset.count = '1';
        rxn.innerHTML = `<span class="rxn-emoji">${emoji}</span><span class="rxn-count">1</span>`;
        rxn.addEventListener('click', () => _toggleReaction(msgEl, msgId, emoji));
        bar.appendChild(rxn);
        rxn.style.animation = 'rxn-pop .25s var(--ease)';
      }
    }
    if (bar.children.length === 0) bar.remove();
  }

  /* ════════════════════════════════════════════════════════════
     CONTEXT MENU (right-click / long-press)
  ════════════════════════════════════════════════════════════ */
  // REACTIONS defined at top of module

  function _removeContextMenu() {
    document.querySelector('.msg-ctx-menu')?.remove();
    document.querySelector('.msg-reactions-bar')?.remove();
  }

  function _showContextMenu(msgEl, id, text, dir, fromPeerId) {
    _removeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'msg-ctx-menu';
    menu.dataset.msgId = id;

    // Reaction strip
    const reactRow = document.createElement('div');
    reactRow.className = 'ctx-reactions';
    REACTIONS.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'ctx-react-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        _sendReaction(id, emoji);
        _addReactionToMsg(msgEl, emoji, true);
        _removeContextMenu();
      });
      reactRow.appendChild(btn);
    });
    menu.appendChild(reactRow);

    // Divider
    const div = document.createElement('div'); div.className = 'ctx-divider'; menu.appendChild(div);

    // Actions
    const actions = [
      { icon: '↩', label: 'Reply', action: () => {
        _setReply({ id, text, sender: dir === 'out' ? (_getMyName?.() || 'You') : _senderName(fromPeerId) });
        _removeContextMenu();
      }},
      { icon: '📋', label: 'Copy', action: () => {
        if (text && text !== '🎤 Voice note') navigator.clipboard?.writeText(text).catch(()=>{});
        _removeContextMenu();
        UI.toast('Copied');
      }},
    ];
    // Add delete for own messages
    if (dir === 'out') {
      actions.push({ icon: '🗑', label: 'Delete', action: () => {
        msgEl.style.transition = 'opacity .2s, transform .2s';
        msgEl.style.opacity = '0'; msgEl.style.transform = 'scale(.9)';
        setTimeout(() => msgEl.remove(), 220);
        _removeContextMenu();
      }});
    }

    actions.forEach(({ icon, label, action }) => {
      const item = document.createElement('button');
      item.className = 'ctx-action';
      item.innerHTML = `<span class="ctx-action-icon">${icon}</span><span>${label}</span>`;
      item.addEventListener('click', action);
      menu.appendChild(item);
    });

    // Position relative to the bubble (msg-inner), not whole msg row
    const msgs   = document.getElementById('chat-messages');
    const bubble = msgEl.querySelector('.msg-inner') || msgEl;
    msgs.appendChild(menu);

    const rect  = bubble.getBoundingClientRect();
    const mRect = msgs.getBoundingClientRect();
    const menuW = 192;
    const menuH = 200; // approximate

    // Prefer below bubble, but flip up if too close to bottom
    let top = rect.bottom - mRect.top + msgs.scrollTop + 6;
    if (rect.bottom + menuH > window.innerHeight) {
      top = rect.top - mRect.top + msgs.scrollTop - menuH - 6;
    }

    // Align with bubble horizontally
    let left = dir === 'out'
      ? rect.right  - mRect.left - menuW
      : rect.left   - mRect.left;

    // Clamp within container
    left = Math.max(4, Math.min(left, mRect.width - menuW - 4));
    top  = Math.max(4, top);

    menu.style.top      = top  + 'px';
    menu.style.left     = left + 'px';
    menu.style.minWidth = menuW + 'px';

    // Close on outside click / tap
    setTimeout(() => {
      document.addEventListener('click',      _removeContextMenu, { once: true });
      document.addEventListener('touchstart', _removeContextMenu, { once: true, passive: true });
    }, 60);
  }

  /* ── Reactions ── */
  function _sendReaction(msgId, emoji) {
    if (!Channels.isOpen(Channels.LABELS.CHAT)) return;
    _send({ type: 'reaction', msgId, emoji });
  }

  function _addReactionToMsg(msgEl, emoji, isOwn) {
    let bar = msgEl.querySelector('.msg-reaction-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'msg-reaction-bar';
      msgEl.appendChild(bar);
    }
    // Check if emoji already exists
    const existing = [...bar.querySelectorAll('.msg-reaction')].find(r => r.dataset.emoji === emoji);
    if (existing) {
      const count = parseInt(existing.dataset.count || '1') + 1;
      existing.dataset.count = count;
      existing.querySelector('.react-count').textContent = count;
      if (isOwn) existing.classList.add('react-mine');
    } else {
      const pill = document.createElement('button');
      pill.className = 'msg-reaction' + (isOwn ? ' react-mine' : '');
      pill.dataset.emoji = emoji;
      pill.dataset.count = '1';
      pill.innerHTML = `<span>${emoji}</span><span class="react-count">1</span>`;
      pill.addEventListener('click', () => {
        if (isOwn) { pill.remove(); } // un-react own
      });
      bar.appendChild(pill);
    }
  }

  /* ════════════════════════════════════════════════════════════
     REPLY BAR
  ════════════════════════════════════════════════════════════ */
  function _setReply(r) {
    _replyTo = r;
    const bar = document.getElementById('reply-bar');
    if (!bar) return;
    bar.classList.remove('hidden');
    bar.querySelector('.reply-bar-sender').textContent = r.sender;
    bar.querySelector('.reply-bar-text').textContent   = (r.text||'').slice(0,80);
    $input()?.focus();
  }

  function _clearReply() {
    _replyTo = null;
    document.getElementById('reply-bar')?.classList.add('hidden');
  }

  /* ════════════════════════════════════════════════════════════
     SEEN TICKS
  ════════════════════════════════════════════════════════════ */
  function _markSeen(msgId) {
    const el = _msgs[msgId];
    if (!el) return;
    const ticks = el.querySelector('.msg-ticks');
    if (!ticks) return;
    // Double tick (seen) — replace SVG with double tick
    ticks.dataset.state = 'seen';
    ticks.innerHTML = `<svg width="18" height="9" viewBox="0 0 22 10" fill="none">
      <path d="M1 5l4 4L15 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M6 5l4 4L20 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  function _sendSeenAck(msgId) {
    _send({ type: 'seen', msgId });
  }

  /* ════════════════════════════════════════════════════════════
     APPEND MESSAGE (public API)
  ════════════════════════════════════════════════════════════ */
  function appendMessage(text, dir, time, fromPeerId, extra) {
    if (dir === 'sys') {
      const el = document.createElement('div');
      el.className = 'msg msg-sys';
      el.textContent = text;
      $msgs().appendChild(el);
      _scrollBottom();
      return;
    }
    // Hide empty state on first real message
    document.getElementById('chat-empty')?.classList.add('hidden');
    const id      = extra?.id || genId();
    const isGroup = _getMode?.() === 'group';
    const el = _buildMsg({ id, dir, text, time: time||Date.now(), fromPeerId, replyTo: extra?.replyTo, audioUrl: extra?.audioUrl, audioDur: extra?.audioDur, isGroup });
    $msgs().appendChild(el);
    _msgs[id] = el;
    _scrollBottom();
    return id;
  }

  function appendSystem(text) { appendMessage(text, 'sys'); }

  /* ════════════════════════════════════════════════════════════
     SEND TEXT
  ════════════════════════════════════════════════════════════ */
  function _sendText() {
    const txt = $input()?.value.trim();
    if (!txt) return;
    if (!Channels.isOpen(Channels.LABELS.CHAT)) { UI.toast('Not connected yet','error'); return; }

    const id      = genId();
    const time    = Date.now();
    const payload = { type:'msg', id, text:txt, time, replyTo: _replyTo || undefined };
    _send(payload);
    appendMessage(txt, 'out', time, null, { id, replyTo: _replyTo });
    $input().value = '';
    _clearReply();
    if (_isTyping) {
      _isTyping = false;
      _send({ type:'typing', value:false });
    }
  }

  /* ════════════════════════════════════════════════════════════
     VOICE NOTES
  ════════════════════════════════════════════════════════════ */
  function _fmtDur(secs) {
    return `${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`;
  }

  /* Secure context — voice/mic requires HTTPS or localhost */
  function _isSecure() {
    // window.isSecureContext is the definitive browser check
    if (typeof window.isSecureContext === 'boolean') return window.isSecureContext;
    // Fallback check
    return location.protocol === 'https:' ||
           location.hostname === 'localhost' ||
           location.hostname === '127.0.0.1' ||
           location.hostname.endsWith('.local');
  }

  /* On mobile, show a tap-to-record UX instead of hold */
  function _isTouchDevice() {
    return navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
  }

  /* Pick best supported mimeType for MediaRecorder */
  function _bestMime() {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ];
    return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function _startRecording() {
    if (_recording) return;

    /* ── Secure context check ── */
    if (!_isSecure()) {
      UI.toast('Voice notes need HTTPS. Open via deployed URL (Railway/Render) or use localhost.', 'error');
      return;
    }

    /* ── API availability ── */
    if (!window.MediaRecorder) {
      UI.toast('Your browser does not support audio recording.', 'error');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      UI.toast('Microphone API not available. Use HTTPS or a modern browser.', 'error');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation:true, noiseSuppression:true } });
      const mime   = _bestMime();
      const mr     = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      _recorder  = mr;
      _recChunks = [];
      _recSecs   = 0;
      _recording = true;

      mr.ondataavailable = e => { if (e.data?.size) _recChunks.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        _onRecordingDone();
      };
      mr.start(100);

      // Update UI
      const btn = document.getElementById('btn-voice');
      if (btn) { btn.classList.add('recording'); btn.title = 'Stop recording'; }
      const ind = document.getElementById('voice-indicator');
      if (ind) { ind.classList.remove('hidden'); ind.querySelector('.vi-dur').textContent = '0:00'; }

      _recTimer = setInterval(() => {
        _recSecs++;
        const ind = document.getElementById('voice-indicator');
        if (ind) ind.querySelector('.vi-dur').textContent = _fmtDur(_recSecs);
        if (_recSecs >= 120) _stopRecording(); // max 2 min
      }, 1000);
    } catch(e) {
      UI.toast('Mic access denied','error');
    }
  }

  function _stopRecording() {
    if (!_recording || !_recorder) return;
    clearInterval(_recTimer);
    _recorder.stop();
    _recording = false;
    const btn = document.getElementById('btn-voice');
    if (btn) { btn.classList.remove('recording'); btn.title = 'Voice note'; }
    const ind = document.getElementById('voice-indicator');
    if (ind) ind.classList.add('hidden');
  }

  function _cancelRecording() {
    if (!_recording || !_recorder) return;
    clearInterval(_recTimer);
    _recorder.onstop = () => {}; // suppress normal handler
    _recorder.stream?.getTracks().forEach(t => t.stop());
    _recorder.stop();
    _recorder  = null;
    _recChunks = [];
    _recording = false;
    const btn = document.getElementById('btn-voice');
    if (btn) { btn.classList.remove('recording'); btn.title = 'Voice note'; }
    document.getElementById('voice-indicator')?.classList.add('hidden');
  }

  async function _onRecordingDone() {
    if (!_recChunks.length) return;
    const mime = _recChunks[0].type || 'audio/webm';
    const blob = new Blob(_recChunks, { type: mime });
    _recChunks  = [];

    // Convert to base64 to send over DataChannel
    const reader = new FileReader();
    reader.onloadend = () => {
      const b64  = reader.result; // data:audio/webm;base64,XXXXX
      const id   = genId();
      const dur  = _fmtDur(_recSecs);
      const time = Date.now();
      const payload = { type:'voice', id, audio:b64, dur, time, replyTo: _replyTo||undefined };

      if (!Channels.isOpen(Channels.LABELS.CHAT)) { UI.toast('Not connected','error'); return; }
      _send(payload);

      const url = URL.createObjectURL(blob);
      appendMessage(null, 'out', time, null, { id, audioUrl:url, audioDur:dur, replyTo:_replyTo });
      _clearReply();
    };
    reader.readAsDataURL(blob);
  }

  /* ════════════════════════════════════════════════════════════
     INCOMING MESSAGE HANDLER
  ════════════════════════════════════════════════════════════ */
  function _onMessage(raw, fromPeerId) {
    // Route education messages
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : null;
      if (parsed?.type === 'edu:msg' && window.EduModule) {
        EduModule.onPeerData(fromPeerId, parsed);
        return;
      }
    } catch(_) {}
    let m; try { m = JSON.parse(raw); } catch { return; }

    // Name handshake — update peer name and refresh header
    if (m.type === 'hello' && m.name) {
      const names = _getPeerNames?.() || {};
      if (names[fromPeerId] !== m.name) {
        names[fromPeerId] = m.name;
        // Trigger UI update via the global helper
        window._updatePeerName?.(fromPeerId, m.name);
      }
      return;
    }

    if (m.type === 'msg') {
      const id = appendMessage(m.text, 'in', m.time, fromPeerId, { id:m.id, replyTo:m.replyTo });
      document.getElementById('typing-indicator').textContent = '';
      // Send seen ack
      if (m.id) _sendSeenAck(m.id);
    }
    else if (m.type === 'voice') {
      // Decode base64 back to blob URL
      let url = m.audio; // keep as data URL — works fine for playback
      appendMessage(null, 'in', m.time, fromPeerId, { id:m.id, audioUrl:url, audioDur:m.dur, replyTo:m.replyTo });
      if (m.id) _sendSeenAck(m.id);
    }
    else if (m.type === 'typing') {
      const name = _senderName(fromPeerId);
      document.getElementById('typing-indicator').textContent = m.value ? `${name} is typing…` : '';
    }
    else if (m.type === 'seen') {
      _markSeen(m.msgId);
    }
    else if (m.type === 'reaction') {
      const el = _msgs[m.msgId];
      if (el) _addReactionToMsg(el, m.emoji, false);
    }
  }

  /* ════════════════════════════════════════════════════════════
     INIT
  ════════════════════════════════════════════════════════════ */
  function init(getMode, getMyName, getPeerNames) {
    _getMode      = getMode;
    _getMyName    = getMyName;
    _getPeerNames = getPeerNames;

    Channels.onMessage(Channels.LABELS.CHAT, _onMessage);

    // Send button
    document.getElementById('btn-send').addEventListener('click', _sendText);

    // Enter to send
    $input()?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendText(); return; }
      const mode = _getMode?.() || 'p2p';
      if (!_isTyping && Channels.isOpen(Channels.LABELS.CHAT)) {
        _isTyping = true;
        _send({ type:'typing', value:true });
      }
      clearTimeout(_typTimer);
      _typTimer = setTimeout(() => {
        _isTyping = false;
        if (Channels.isOpen(Channels.LABELS.CHAT)) _send({ type:'typing', value:false });
      }, 2000);
    });

    // Voice button — desktop: hold to record / mobile: tap to start, tap again to stop
    const vBtn = document.getElementById('btn-voice');
    if (vBtn) {
      if (!_isSecure()) {
        vBtn.title = 'Voice notes need HTTPS';
        vBtn.style.opacity = '.45';
        vBtn.style.cursor  = 'not-allowed';
      }

      if (_isTouchDevice()) {
        // ── Mobile: single tap toggles record/stop ──
        vBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          if (_recording) {
            _stopRecording();
          } else {
            await _startRecording();
          }
        });
      } else {
        // ── Desktop: hold to record ──
        vBtn.addEventListener('mousedown',  e => { e.preventDefault(); _startRecording(); });
        vBtn.addEventListener('mouseup',    e => { e.preventDefault(); _stopRecording(); });
        vBtn.addEventListener('mouseleave', ()  => { if (_recording) _stopRecording(); });
      }
    }

    // Cancel recording
    document.getElementById('btn-voice-cancel')?.addEventListener('click', _cancelRecording);

    // Reply bar close
    document.getElementById('reply-bar-close')?.addEventListener('click', _clearReply);

    // IntersectionObserver for seen — mark as seen when message scrolls into view
    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (!e.isIntersecting) return;
        const el  = e.target;
        const id  = el.dataset.msgId;
        // If it's an incoming message, send seen ack (already done on receive — this is backup)
        io.unobserve(el);
      });
    }, { threshold: 0.8 });

    // Observe future messages
    const observer = new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType === 1 && n.classList.contains('msg-in')) io.observe(n);
      }));
    });
    const msgs = $msgs();
    if (msgs) observer.observe(msgs, { childList: true });
  }

  return { init, appendSystem, appendMessage };
})();

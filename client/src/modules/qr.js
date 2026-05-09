'use strict';
window.QRModule = (() => {
  let _libLoaded = false;
  let _appUrl    = null;
  let _lastUrl   = null;  // keep the generated URL for copy fallback

  function _loadLib() {
    return new Promise(resolve => {
      if (_libLoaded || window.QRCode) { _libLoaded = true; resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = () => { _libLoaded = true; resolve(); };
      s.onerror = () => resolve();
      document.head.appendChild(s);
    });
  }

  async function _getAppUrl() {
    if (_appUrl) return _appUrl;
    try {
      const r = await fetch('/api/server-info');
      const d = await r.json();
      _appUrl = (d.appUrl || location.origin).replace(/\/$/, '');
    } catch {
      _appUrl = location.origin;
    }
    return _appUrl;
  }

  async function generate(roomId, mode) {
    await _loadLib();
    const base = await _getAppUrl();
    const url  = `${base}?room=${encodeURIComponent(roomId)}&mode=${mode || 'p2p'}`;
    _lastUrl   = url;

    // Build QR
    const wrap = document.getElementById('qr-canvas-wrap');
    wrap.innerHTML = '';
    delete wrap._oQRCode;

    if (window.QRCode) {
      const target = document.createElement('div');
      wrap.appendChild(target);
      new window.QRCode(target, {
        text:         url,
        width:        180,
        height:       180,
        colorDark:    '#0a2626',
        colorLight:   '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M,
      });
      const hide = () => target.querySelectorAll('img').forEach(i => { i.style.display = 'none'; });
      hide();
      const mo = new MutationObserver(hide);
      mo.observe(target, { childList: true, subtree: true });
      setTimeout(() => { mo.disconnect(); hide(); }, 800);
    } else {
      wrap.innerHTML = `<a href="${url}" style="font-size:.65rem;word-break:break-all;color:var(--a2);padding:.5rem;display:block">${url}</a>`;
    }

    // Show URL text
    const txt = document.getElementById('room-id-text');
    if (txt) txt.textContent = url;

    // Show QR section
    const sec = document.getElementById('qr-section');
    if (sec) sec.classList.remove('hidden');

    // Wire copy button with textarea fallback for HTTP
    const btn = document.getElementById('btn-copy-room');
    if (btn) {
      // Remove any old listener by cloning
      const fresh = btn.cloneNode(true);
      btn.parentNode.replaceChild(fresh, btn);
      fresh.addEventListener('click', () => _copyUrl(url, fresh));
    }

    return url;
  }

  function _copyUrl(url, btn) {
    const ok = () => {
      const orig = btn.innerHTML;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 1600);
    };
    const fail = () => {
      // textarea fallback — works on HTTP
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        document.execCommand('copy');
        ta.remove();
        ok();
      } catch {
        UI.toast('Copy failed — select URL manually', 'error');
      }
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(ok).catch(fail);
    } else {
      fail();
    }
  }

  function getRoomFromUrl() {
    return new URLSearchParams(location.search).get('room') || null;
  }

  return { generate, getRoomFromUrl };
})();

'use strict';
window.QRModule = (() => {
  let _libLoaded = false;
  let _appUrl    = null;
  let _lastUrl   = null;

  function _loadLib() {
    return new Promise(resolve => {
      if (_libLoaded || window.QRCode) { _libLoaded = true; resolve(); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload  = () => { _libLoaded = true; resolve(); };
      s.onerror = () => resolve(); // graceful fallback
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
    if (wrap) {
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
        // Hide auto-generated img, show only canvas
        const hide = () => target.querySelectorAll('img').forEach(i => { i.style.display = 'none'; });
        hide();
        const mo = new MutationObserver(hide);
        mo.observe(target, { childList: true, subtree: true });
        setTimeout(() => { mo.disconnect(); hide(); }, 800);
      } else {
        wrap.innerHTML = `<a href="${url}" style="font-size:.65rem;word-break:break-all;color:var(--a2);padding:.5rem;display:block">${url}</a>`;
      }
    }

    // Show URL text
    const txt = document.getElementById('room-id-text');
    if (txt) txt.textContent = url;

    // Show QR section
    document.getElementById('qr-section')?.classList.remove('hidden');

    // ── Copy invite button — works on HTTP & HTTPS ──
    _wireCopyBtn(url);

    return url;
  }

  function _wireCopyBtn(url) {
    const btn = document.getElementById('btn-copy-room');
    if (!btn) return;
    // Clone to remove old listeners
    const fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);
    fresh.addEventListener('click', () => _copyUrl(url, fresh));
  }

  function _copyUrl(url, btn) {
    const origHTML = btn.innerHTML;

    function success() {
      btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      btn.style.color = 'var(--cyan3)';
      setTimeout(() => {
        btn.innerHTML = origHTML;
        btn.style.color = '';
      }, 2000);
      UI.toast('Invite link copied!');
    }

    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (ok) { success(); }
        else    { _promptManual(url); }
      } catch {
        _promptManual(url);
      }
    }

    // Try modern Clipboard API first
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url)
        .then(success)
        .catch(fallback);
    } else {
      fallback();
    }
  }

  function _promptManual(url) {
    // Last resort: prompt so the user can manually copy
    try { window.prompt('Copy this invite link:', url); }
    catch { UI.toast('Copy failed — select the URL manually', 'error'); }
  }

  function getRoomFromUrl() {
    return new URLSearchParams(location.search).get('room') || null;
  }

  // Expose _lastUrl so app.js can re-copy if needed
  function getLastUrl() { return _lastUrl; }

  return { generate, getRoomFromUrl, getLastUrl };
})();

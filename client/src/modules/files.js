'use strict';
window.FilesModule = (() => {
  const CHUNK   = 16 * 1024;       // 16 KB per chunk
  const HIGH_WM = 1 * 1024 * 1024; // pause when buffer > 1 MB
  const LOW_WM  = 256 * 1024;      // resume when buffer < 256 KB
  const _in     = {};
  let _getMode;

  /* ── UI helpers ── */
  function $l()   { return document.getElementById('transfer-list'); }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function fmt(b) {
    return b < 1024 ? b+' B'
         : b < 1048576 ? (b/1024).toFixed(1)+' KB'
         : (b/1048576).toFixed(2)+' MB';
  }

  function mkItem(id, name, size, dir, file) {
    const el = document.createElement('div');
    el.className = 'transfer-item'; el.id = 'ti-'+id;
    el.innerHTML =
      `<div class="ti-top">`+
        `<span class="ti-name" title="${esc(name)}">${esc(name)}</span>`+
        `<span class="ti-badge ${dir}">${dir==='out'?'↑ Sending':'↓ Receiving'}</span>`+
      `</div>`+
      `<div class="ti-meta">${fmt(size)}</div>`+
      `<div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div>`+
      `<div class="ti-pct">0%</div>`;

    // Outgoing image preview
    if (dir === 'out' && file && file.type?.startsWith('image/')) {
      const wrap = document.createElement('div');
      wrap.className = 'ti-img-wrap';
      const img = document.createElement('img');
      img.className = 'ti-img';
      img.alt = name;
      const reader = new FileReader();
      reader.onload = e => {
        img.src = e.target.result;
        img.onload = () => wrap.classList.add('loaded');
        img.addEventListener('click', () => _openLightbox(e.target.result, name));
      };
      reader.readAsDataURL(file);
      wrap.appendChild(img);
      el.insertBefore(wrap, el.querySelector('.ti-meta').nextSibling);
      el.classList.add('ti-has-image');
    }

    $l().prepend(el);
    return el;
  }

  function setPct(el, p) {
    el.querySelector('.progress-fill').style.width = Math.min(p,100)+'%';
    el.querySelector('.ti-pct').textContent = p >= 100 ? '✓ Complete' : p+'%';
  }

  function setStatus(el, text, cls) {
    el.querySelector('.ti-pct').textContent = text;
    if (cls) el.querySelector('.ti-badge').className = 'ti-badge ' + cls;
  }

  function addSave(el, name, blob) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = name; a.className = 'ti-save';
    a.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save`;
    el.querySelector('.ti-badge').textContent = '✓ Received';
    el.querySelector('.ti-badge').className   = 'ti-badge done';
    el.querySelector('.ti-pct').textContent   = '✓ Complete';

    // ── Image preview ──
    const isImage = blob.type.startsWith('image/');
    if (isImage) {
      const wrap = document.createElement('div');
      wrap.className = 'ti-img-wrap';
      const img = document.createElement('img');
      img.src = url;
      img.className = 'ti-img';
      img.alt = name;
      img.onload = () => wrap.classList.add('loaded');
      // Click → lightbox
      img.addEventListener('click', () => _openLightbox(url, name));
      wrap.appendChild(img);
      // Insert before the save button area
      el.insertBefore(wrap, el.querySelector('.ti-pct'));
      el.classList.add('ti-has-image');
    }

    el.appendChild(a);
  }

  /* ── Lightbox ── */
  function _openLightbox(url, name) {
    let lb = document.getElementById('ti-lightbox');
    if (!lb) {
      lb = document.createElement('div');
      lb.id = 'ti-lightbox';
      lb.innerHTML = `
        <div class="ti-lb-backdrop"></div>
        <div class="ti-lb-inner">
          <img class="ti-lb-img" />
          <div class="ti-lb-bar">
            <span class="ti-lb-name"></span>
            <a class="ti-lb-dl ti-save" download>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save
            </a>
            <button class="ti-lb-close">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>`;
      document.body.appendChild(lb);
      const close = () => { lb.classList.remove('open'); setTimeout(() => lb.classList.remove('visible'), 300); };
      lb.querySelector('.ti-lb-backdrop').addEventListener('click', close);
      lb.querySelector('.ti-lb-close').addEventListener('click', close);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    }
    lb.querySelector('.ti-lb-img').src = url;
    lb.querySelector('.ti-lb-name').textContent = name;
    lb.querySelector('.ti-lb-dl').href = url;
    lb.querySelector('.ti-lb-dl').download = name;
    lb.classList.add('visible');
    requestAnimationFrame(() => lb.classList.add('open'));
  }

  /* ── Send one file to one peer via its DataChannel (event-driven backpressure) ── */
  async function _pumpToPeer(buf, el, id, total, dc) {
    function buildChunk(i) {
      const slice    = buf.slice(i * CHUNK, (i+1) * CHUNK);
      const hdr      = JSON.stringify({ type:'file-chunk', transferId:id, index:i });
      const hdrBytes = new TextEncoder().encode(hdr);
      const out      = new Uint8Array(4 + hdrBytes.length + slice.byteLength);
      new DataView(out.buffer).setUint32(0, hdrBytes.length);
      out.set(hdrBytes, 4);
      out.set(new Uint8Array(slice), 4 + hdrBytes.length);
      return out.buffer;
    }

    dc.bufferedAmountLowThreshold = LOW_WM;

    for (let i = 0; i < total; i++) {
      if (dc.readyState !== 'open') {
        setStatus(el, '✗ Disconnected', 'err'); return;
      }
      if (dc.bufferedAmount > HIGH_WM) {
        await new Promise(resolve => {
          const onLow = () => { dc.removeEventListener('bufferedamountlow', onLow); resolve(); };
          dc.addEventListener('bufferedamountlow', onLow);
        });
      }
      dc.send(buildChunk(i));
      setPct(el, Math.round(((i+1)/total)*100));
      if (i % 50 === 0) await new Promise(r => setTimeout(r, 0));
    }
  }

  /* ── Main send ── */
  async function sendFile(file, toPeerId) {
    const label = Channels.LABELS.FILE;
    const mode  = _getMode ? _getMode() : 'p2p';

    if (!Channels.isOpen(label)) { UI.toast('Not connected', 'error'); return; }

    const id    = Date.now().toString(36) + Math.random().toString(36).slice(2,8);
    const total = Math.ceil(file.size / CHUNK) || 1;
    const el    = mkItem(id, file.name, file.size, 'out', file);

    /* Read entire file once into memory — cross-browser (iOS Safari < 14.5 lacks arrayBuffer) */
    let buf;
    try {
      if (typeof file.arrayBuffer === 'function') {
        buf = await file.arrayBuffer();
      } else {
        // FileReader fallback for older mobile browsers
        buf = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload  = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(file);
        });
      }
    } catch(e) {
      console.error('[files] read error:', e);
      setStatus(el, '✗ Cannot read file', 'err');
      UI.toast('Cannot read file: ' + (e?.message || 'unknown error'), 'error');
      return;
    }

    /* ── Determine which peers to send to ── */
    let peers; // array of peerIds
    if (mode === 'group') {
      peers = toPeerId ? [toPeerId] : Channels.openPeers(label);
    } else {
      peers = toPeerId ? [toPeerId] : Channels.openPeers(label);
    }

    if (!peers.length) { setStatus(el,'✗ No peers','err'); return; }

    /* ── Send metadata to all target peers ── */
    const meta = {
      type:'file-meta', transferId:id,
      name:file.name, size:file.size,
      totalChunks:total,
      mime: file.type || 'application/octet-stream'
    };
    for (const pid of peers) {
      Channels.sendToJSON(pid, label, meta);
    }

    /* ── Pump chunks to every peer concurrently ── */
    // Each peer gets its own independent pump so backpressure on one
    // peer doesn't block delivery to others.
    const pumps = peers.map(pid => {
      const dc = Channels.getRawChannel(label, pid);
      if (!dc) { console.warn('[files] no raw channel for', pid); return Promise.resolve(); }
      return _pumpToPeer(buf, el, id, total, dc);
    });

    await Promise.all(pumps);
    setStatus(el, '✓ Complete', 'done');
  }

  /* ── Receive ── */
  function onData(data, fromPeerId) {
    if (data instanceof ArrayBuffer) {
      const dv   = new DataView(data);
      const mLen = dv.getUint32(0);
      let meta;
      try { meta = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 4, mLen))); }
      catch { return; }
      const chunk = data.slice(4 + mLen);
      const tx    = _in[meta.transferId];
      if (!tx) return;
      tx.chunks[meta.index] = chunk; tx.got++;
      setPct(tx.el, Math.round((tx.got / tx.total) * 100));
      if (tx.got === tx.total) {
        addSave(tx.el, tx.name, new Blob(tx.chunks, { type: tx.mime }));
        UI.toast('Received: ' + tx.name);
        delete _in[meta.transferId];
      }
      return;
    }
    let msg; try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'file-meta') {
      const el = mkItem(msg.transferId, msg.name, msg.size, 'in');
      _in[msg.transferId] = {
        el, name:msg.name, mime:msg.mime,
        total:msg.totalChunks, got:0, chunks:[]
      };
      UI.toast('Incoming: ' + msg.name + ' (' + fmt(msg.size) + ')');
    }
  }

  /* ── Drop zone ── */
  function initDrop() {
    const zone  = document.getElementById('drop-zone');
    const input = document.getElementById('file-input');
    if (!zone || !input) return;
    zone.addEventListener('dragenter', e => e.preventDefault());
    zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      [...(e.dataTransfer.files||[])].forEach(f => sendFile(f));
    });
    zone.addEventListener('click', e => {
      if (e.target.tagName==='LABEL'||e.target.tagName==='INPUT'||e.target.closest('label')) return;
      input.click();
    });
    input.addEventListener('change', () => {
      [...(input.files||[])].forEach(f => sendFile(f));
      input.value = '';
    });
  }

  function init(getMode) {
    _getMode = getMode;
    Channels.onMessage(Channels.LABELS.FILE, onData);
    initDrop();
  }

  return { init, sendFile };
})();

'use strict';
window.CallModule = (() => {

  /* ── State ── */
  let _type      = 'audio';
  let _state     = 'idle';
  let _minimized = false;
  let _local     = null;
  let _screen    = null;
  let _remotes   = {};
  let _muted     = false;
  let _camOff    = false;
  let _sharing   = false;
  let _timer     = null;
  let _secs      = 0;
  let _callee    = null;
  let _caller    = null;
  let _ringIv    = null;
  let _ringCtx   = null;
  let _hideTimer = null;

  const $ = id => document.getElementById(id);

  /* ── Secure context check — fixed to work on all HTTPS + localhost ── */
  const _secure = () => {
    if (location.protocol === 'https:') return true;
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (h.endsWith('.local') || h.endsWith('.internal')) return true;
    return false;
  };

  /* ── Get mic/cam with better error handling & permission query ── */
  async function _media(video) {
    if (!_secure()) {
      UI.toast('Calls require HTTPS or localhost. Connect via https:// to use mic/cam.', 'error');
      return null;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      UI.toast('Your browser does not support media access. Try Chrome or Firefox.', 'error');
      return null;
    }

    // Check permission state first (non-blocking hint)
    try {
      if (navigator.permissions) {
        const p = await navigator.permissions.query({ name: 'microphone' });
        if (p.state === 'denied') {
          UI.toast('Microphone blocked — click the lock icon in your browser address bar to allow access.', 'error');
          return null;
        }
      }
    } catch (_) { /* permissions API not available — try getUserMedia anyway */ }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
          sampleRate:       48000,
        },
        video: video ? {
          width:      { ideal: 1280 },
          height:     { ideal: 720  },
          facingMode: 'user',
          frameRate:  { ideal: 30  },
        } : false,
      });
      return stream;
    } catch (e) {
      console.error('[call] getUserMedia error:', e.name, e.message);
      const msgs = {
        NotAllowedError:       `Microphone${video ? '/camera' : ''} access denied. Click the 🔒 icon in your browser bar to allow it.`,
        PermissionDeniedError: `Microphone${video ? '/camera' : ''} access denied. Check browser permissions.`,
        NotFoundError:         `No microphone${video ? ' or camera' : ''} found. Plug in a device and try again.`,
        NotReadableError:      'Microphone/camera is in use by another app. Close other apps and retry.',
        OverconstrainedError:  'Camera constraints not supported — trying again with lower quality.',
        AbortError:            'Media access aborted. Please try again.',
        SecurityError:         'Media access blocked (SecurityError). Ensure you are on HTTPS.',
        TypeError:             'Media configuration error. Please try again.',
      };
      const msg = msgs[e.name] || `Media error (${e.name}): ${e.message}`;
      UI.toast(msg, 'error');

      // Retry with relaxed constraints on OverconstrainedError
      if (e.name === 'OverconstrainedError' && video) {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        } catch (e2) {
          UI.toast('Could not access camera: ' + e2.message, 'error');
        }
      }
      return null;
    }
  }

  /* ── Peer name helper ── */
  function _name(id) {
    return (window._getPeerName && id && window._getPeerName(id)) || 'Peer';
  }

  /* ════════════════════════════════════════════════════════════
     UI STATE MACHINE
  ════════════════════════════════════════════════════════════ */
  function _ui(state) {
    _state = state;
    const scr = $('call-screen');
    const bar = $('call-bar');
    if (!scr || !bar) return;

    const idle   = state === 'idle';
    const out    = state === 'ringing_out';
    const inn    = state === 'ringing_in';
    const active = state === 'active';

    scr.classList.toggle('hidden', idle);
    bar.style.display = idle ? '' : 'none';

    const rv   = $('video-remote');
    const av   = $('cs-avatar');
    const gr   = $('cs-grid');
    const mode = window._getMode ? window._getMode() : 'p2p';
    const hasRemoteVideo = active && _type === 'video';
    if (rv) rv.style.display = (hasRemoteVideo && mode !== 'group') ? 'block' : 'none';
    if (gr) gr.classList.toggle('hidden', !(active && mode === 'group'));
    if (av) av.classList.toggle('hidden', hasRemoteVideo);

    $('cs-ring-screen')?.classList.toggle('hidden',  !(out || inn));
    $('cs-ring-actions')?.classList.toggle('hidden', !inn);
    $('cs-controls')?.classList.toggle('hidden',     !active);
    $('cs-timer')?.classList.toggle('hidden',         !active);

    const pip = $('video-local');
    if (pip) pip.classList.toggle('hidden', !(active && _type === 'video'));

    const pn = $('cs-peer-name'), st = $('cs-call-status');
    if (out || inn) {
      const n = out ? _name(_callee) : _name(_caller);
      if (pn) pn.textContent = n;
      if (st) st.textContent = out ? 'Calling…' : (_type === 'video' ? 'Video call' : 'Voice call');
      const rn = $('cs-ring-name'), rs = $('cs-ring-status'), an = $('cs-avatar-name');
      if (rn) rn.textContent = n;
      if (rs) rs.textContent = out ? 'Calling…' : (_type === 'video' ? 'Incoming video call' : 'Incoming voice call');
      if (an) an.textContent = n;
    }
    if (active) {
      const n = _name(_callee || _caller);
      if (pn) pn.textContent = n;
      if (st) st.textContent = _sharing ? 'Sharing screen' : (_type === 'video' ? 'Video call' : 'Voice call');
    }

    $('cs-share-badge')?.classList.toggle('hidden', !(_sharing && active));
  }

  /* ── Group video grid layout ── */
  function _updateGrid() {
    const grid = $('cs-grid');
    if (!grid) return;
    const cells = grid.querySelectorAll('.cs-grid-cell');
    const n = cells.length || 1;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows    = `repeat(${rows}, 1fr)`;
  }

  function _addGridCell(peerId, stream) {
    const grid = $('cs-grid');
    if (!grid) return;
    let cell = grid.querySelector(`[data-peer="${peerId}"]`);
    if (!cell) {
      cell = document.createElement('div');
      cell.className = 'cs-grid-cell';
      cell.dataset.peer = peerId;
      const vid = document.createElement('video');
      vid.autoplay = true; vid.playsInline = true;
      const lbl = document.createElement('div');
      lbl.className = 'cs-grid-cell-label';
      lbl.textContent = _name(peerId);
      cell.appendChild(vid); cell.appendChild(lbl);
      grid.appendChild(cell);
    }
    const vid = cell.querySelector('video');
    if (vid && stream) { vid.srcObject = stream; vid.play().catch(() => {}); }
    _updateGrid();
  }

  function _removeGridCell(peerId) {
    $('cs-grid')?.querySelector(`[data-peer="${peerId}"]`)?.remove();
    _updateGrid();
  }

  /* ── Controls fade ── */
  function _show() {
    const ctrl = $('cs-controls'), top = document.querySelector('.cs-topbar');
    if (!ctrl) return;
    ctrl.style.opacity = '1'; ctrl.style.pointerEvents = 'auto';
    if (top) { top.style.opacity = '1'; top.style.pointerEvents = 'auto'; }
    clearTimeout(_hideTimer);
    if (_type === 'video' && !_sharing) {
      _hideTimer = setTimeout(() => {
        ctrl.style.opacity = '0'; ctrl.style.pointerEvents = 'none';
        if (top) { top.style.opacity = '0'; top.style.pointerEvents = 'none'; }
      }, 5000);
    }
  }

  /* ── Timer ── */
  function _startTimer() {
    _secs = 0;
    if ($('cs-timer')) $('cs-timer').textContent = '00:00';
    _timer = setInterval(() => {
      _secs++;
      const m = String(Math.floor(_secs / 60)).padStart(2, '0');
      const s = String(_secs % 60).padStart(2, '0');
      const el = $('cs-timer'); if (el) el.textContent = `${m}:${s}`;
      _syncPipTimer();
    }, 1000);
  }
  function _stopTimer() { clearInterval(_timer); _timer = null; _secs = 0; }

  /* ── Track management ── */
  function _addLocal(peerId) {
    const tracks = [...(_local?.getTracks() || []), ...(_screen?.getTracks() || [])];
    const peers = peerId ? [peerId] : RTCManager.connectedPeers();
    for (const pid of peers) {
      const pc = RTCManager._pcs[pid];
      if (!pc) continue;
      pc.getSenders()
        .filter(s => s.track?.kind === 'audio' || s.track?.kind === 'video')
        .forEach(s => { try { pc.removeTrack(s); } catch (_) {} });
      tracks.forEach(t => pc.addTrack(t, _local || new MediaStream([t])));
    }
  }

  function onRemoteTrack(event, fromPeerId) {
    const track = event.track;
    if (!_remotes[fromPeerId]) _remotes[fromPeerId] = new MediaStream();
    _remotes[fromPeerId].addTrack(track);

    const mode = window._getMode ? window._getMode() : 'p2p';

    if (track.kind === 'audio') {
      let el = document.querySelector(`audio[data-peer="${fromPeerId}"]`);
      if (!el) {
        el = document.createElement('audio');
        el.autoplay = true; el.playsInline = true;
        el.setAttribute('data-peer', fromPeerId);
        document.body.appendChild(el);
      }
      el.srcObject = _remotes[fromPeerId];
    }

    if (track.kind === 'video') {
      if (mode === 'group') {
        _addGridCell(fromPeerId, _remotes[fromPeerId]);
      } else {
        const rv = $('video-remote');
        if (rv) {
          rv.srcObject = _remotes[fromPeerId];
          rv.style.display = 'block';
          rv.style.objectFit = 'contain';
          $('cs-avatar')?.classList.add('hidden');
          rv.play().catch(() => {});
        }
      }
    }

    track.onended = () => {
      _remotes[fromPeerId]?.removeTrack(track);
      if (track.kind === 'video' && mode !== 'group') {
        const rv = $('video-remote');
        const remaining = _remotes[fromPeerId]?.getVideoTracks() || [];
        if (remaining.length === 0 && rv) {
          rv.style.display = 'none';
          $('cs-avatar')?.classList.remove('hidden');
        }
      }
    };
  }

  function _showLocal() {
    const el = $('video-local');
    if (el && _local) { el.srcObject = _local; el.muted = true; el.play().catch(() => {}); }
  }

  /* ── Signaling ── */
  function _sig(payload, to) {
    SignalingSocket.send({ type: 'call-signal', payload, to: to || undefined });
  }

  async function _renegotiate() {
    const peers = _callee ? [_callee] : RTCManager.connectedPeers();
    for (const pid of peers) {
      const pc = RTCManager._pcs[pid];
      if (!pc) continue;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        SignalingSocket.send({ type: 'offer', payload: offer, to: pid });
      } catch (e) { console.warn('[call] renegotiate:', e); }
    }
  }

  /* ── Start call ── */
  async function startCall(type, toPeerId) {
    if (_state !== 'idle') { UI.toast('Already in a call', 'error'); return; }
    // Check if there's anyone to call
    if (RTCManager.connectedPeers().length === 0 && !toPeerId) {
      UI.toast('No one connected to call yet', 'error'); return;
    }
    _type = type || 'audio';
    const stream = await _media(_type === 'video');
    if (!stream) return;
    _local = stream; _callee = toPeerId || null;
    if (_type === 'video') _showLocal();
    _ui('ringing_out');
    _sig({ action: 'ring', callType: _type }, toPeerId);
    _playRing(true);
    setTimeout(() => { if (_state === 'ringing_out') hangup('no_answer'); }, 45000);
  }

  /* ── Accept ── */
  async function acceptCall() {
    if (_state !== 'ringing_in') return;
    const stream = await _media(_type === 'video');
    if (!stream) {
      _sig({ action: 'reject', reason: 'mic_denied' }, _caller);
      _cleanup(); _ui('idle'); return;
    }
    _local = stream;
    if (_type === 'video') _showLocal();
    _addLocal(_caller);
    await _renegotiate();
    _sig({ action: 'accept', callType: _type }, _caller);
    _ui('active'); _startTimer(); _playRing(false); _show();
    UI.toast('Call connected');
  }

  /* ── Hang up ── */
  function hangup(reason) {
    if (_state === 'idle') return;
    const wasActive = _state === 'active';
    _sig({ action: 'end', reason: reason || 'hangup' }, _callee || _caller || undefined);
    _cleanup(); _ui('idle');
    if (wasActive)                UI.toast('Call ended');
    else if (reason === 'no_answer') UI.toast('No answer');
    else if (reason === 'rejected')  UI.toast('Call declined');
  }

  function rejectCall() {
    if (_state !== 'ringing_in') return;
    _sig({ action: 'reject' }, _caller);
    _cleanup(); _ui('idle');
  }

  /* ── Controls ── */
  function toggleMute() {
    if (!_local) return;
    _muted = !_muted;
    _local.getAudioTracks().forEach(t => { t.enabled = !_muted; });
    const btn = $('call-btn-mute');
    if (btn) {
      btn.classList.toggle('muted', _muted);
      btn.dataset.label = _muted ? 'Unmute' : 'Mute';
      btn.title = _muted ? 'Unmute' : 'Mute';
    }
    UI.toast(_muted ? 'Muted' : 'Unmuted');
  }

  function toggleCamera() {
    if (!_local) return;
    _camOff = !_camOff;
    _local.getVideoTracks().forEach(t => { t.enabled = !_camOff; });
    const btn = $('call-btn-cam');
    if (btn) {
      btn.classList.toggle('cam-off', _camOff);
      btn.dataset.label = _camOff ? 'Cam on' : 'Camera';
    }
    UI.toast(_camOff ? 'Camera off' : 'Camera on');
  }

  /* ── Screen share — hardened ── */
  async function toggleShare() {
    if (!_secure()) { UI.toast('Screen share requires HTTPS.', 'error'); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      UI.toast('Screen share not supported in this browser. Use Chrome or Edge.', 'error');
      return;
    }
    if (_state !== 'active') {
      UI.toast('Start a call first before sharing your screen.', 'error');
      return;
    }

    if (_sharing) {
      /* Stop sharing */
      const camTrack = _local?.getVideoTracks()[0] || null;
      _screen?.getTracks().forEach(t => t.stop());
      _screen = null;
      _sharing = false;

      const peers = RTCManager.connectedPeers();
      let replaced = false;
      for (const pid of peers) {
        const pc = RTCManager._pcs[pid];
        if (!pc) continue;
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender && camTrack) {
          await sender.replaceTrack(camTrack).catch(() => {});
          replaced = true;
        } else if (sender && !camTrack) {
          try { pc.removeTrack(sender); } catch (_) {}
          replaced = true;
        }
      }
      if (!replaced) { _addLocal(); await _renegotiate(); }

      const lv = $('video-local');
      if (lv) {
        if (_type === 'video' && _local) {
          lv.srcObject = _local; lv.classList.remove('hidden'); lv.play().catch(() => {});
        } else {
          lv.srcObject = null; lv.classList.add('hidden');
        }
      }

      const rv = $('video-remote');
      if (rv && _type === 'video') {
        const remotePeerId = _callee || _caller;
        if (remotePeerId && _remotes[remotePeerId]) {
          rv.srcObject = _remotes[remotePeerId];
          rv.style.display = 'block';
          rv.play().catch(() => {});
          $('cs-avatar')?.classList.add('hidden');
        }
        rv.style.objectFit = 'contain';
      }

      const btn = $('call-btn-share');
      if (btn) { btn.classList.remove('sharing'); btn.dataset.label = 'Share'; btn.title = 'Share screen'; }
      $('cs-share-badge')?.classList.add('hidden');
      $('call-screen')?.classList.remove('screen-sharing');
      const st = $('cs-call-status');
      if (st) st.textContent = _type === 'video' ? 'Video call' : 'Voice call';
      UI.toast('Screen share stopped');
      return;
    }

    /* Start sharing */
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', displaySurface: 'monitor', frameRate: 30 },
        audio: false,
      });
      _screen = stream;
      _sharing = true;

      const videoTrack = stream.getVideoTracks()[0];
      const peers = RTCManager.connectedPeers();
      for (const pid of peers) {
        const pc = RTCManager._pcs[pid];
        if (!pc) continue;
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(videoTrack).catch(() => {});
        } else {
          pc.addTrack(videoTrack, stream);
        }
      }
      // If no video was in call, renegotiate to add the track
      if (peers.every(pid => {
        const pc = RTCManager._pcs[pid];
        return !pc?.getSenders().find(s => s.track?.kind === 'video');
      })) {
        _addLocal(); await _renegotiate();
      }

      const lv = $('video-local');
      if (lv) { lv.srcObject = stream; lv.classList.remove('hidden'); }

      const rv = $('video-remote');
      if (rv) rv.style.objectFit = 'contain';
      $('call-screen')?.classList.add('screen-sharing');

      const btn = $('call-btn-share');
      if (btn) { btn.classList.add('sharing'); btn.dataset.label = 'Stop'; btn.title = 'Stop sharing'; }
      $('cs-share-badge')?.classList.remove('hidden');
      const st = $('cs-call-status'); if (st) st.textContent = 'Sharing screen';

      videoTrack.onended = () => { if (_sharing) toggleShare(); };

      UI.toast('Screen sharing started');
    } catch (e) {
      _sharing = false; _screen = null;
      if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') {
        UI.toast('Screen share failed: ' + e.message, 'error');
      }
    }
  }

  /* ── Cleanup ── */
  function _cleanup() {
    _stopTimer(); _playRing(false); clearTimeout(_hideTimer);
    _local?.getTracks().forEach(t => t.stop()); _local = null;
    _screen?.getTracks().forEach(t => t.stop()); _screen = null;
    _muted = false; _camOff = false; _sharing = false;

    const lv = $('video-local');  if (lv) { lv.srcObject = null; }
    const rv = $('video-remote'); if (rv) { rv.srcObject = null; rv.style.display = 'none'; }
    const gr = $('cs-grid');      if (gr) { gr.innerHTML = ''; gr.classList.add('hidden'); }
    document.querySelectorAll('audio[data-peer]').forEach(a => { a.srcObject = null; a.remove(); });
    _remotes = {};

    for (const pc of Object.values(RTCManager._pcs)) {
      pc.getSenders()
        .filter(s => s.track?.kind === 'audio' || s.track?.kind === 'video')
        .forEach(s => { try { pc.removeTrack(s); } catch (_) {} });
    }
    _callee = null; _caller = null; _minimized = false;
    $('call-pip')?.classList.add('hidden');

    const btn = $('call-btn-share');
    if (btn) { btn.classList.remove('sharing'); btn.dataset.label = 'Share'; }
    $('cs-share-badge')?.classList.add('hidden');
  }

  /* ── Handle incoming signal ── */
  function handleSignal(msg, fromPeerId) {
    const { action, callType } = msg;
    if (action === 'ring') {
      if (_state !== 'idle') { _sig({ action: 'reject', reason: 'busy' }, fromPeerId); return; }
      _caller = fromPeerId; _type = callType || 'audio';
      _ui('ringing_in'); _playRing(true); return;
    }
    if (action === 'accept') {
      if (_state !== 'ringing_out') return;
      _addLocal(fromPeerId); _renegotiate();
      _ui('active'); _startTimer(); _playRing(false); _show();
      UI.toast('Call connected'); return;
    }
    if (action === 'reject') {
      _cleanup(); _ui('idle'); _playRing(false);
      UI.toast('Call declined', 'error'); return;
    }
    if (action === 'end') {
      if (_state === 'idle') return;
      const was = _state === 'active';
      _cleanup(); _ui('idle'); _playRing(false);
      if (was) { ChatModule.appendSystem('Call ended.'); UI.toast('Call ended'); } return;
    }
  }

  /* ── Ring tone ── */
  function _playRing(on) {
    clearInterval(_ringIv); _ringIv = null;
    if (_ringCtx) { try { _ringCtx.close(); } catch (_) {} _ringCtx = null; }
    if (!on) return;
    function beep() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        _ringCtx = ctx;
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = 480;
        gain.gain.setValueAtTime(0.22, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.65);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(); osc.stop(ctx.currentTime + 0.65);
      } catch (_) {}
    }
    beep(); _ringIv = setInterval(beep, 2000);
  }

  /* ── Minimize / restore ── */
  function minimize() {
    if (_state !== 'active') return;
    _minimized = true;
    $('call-screen')?.classList.add('hidden');
    const pip = $('call-pip');
    if (!pip) return;
    pip.classList.remove('hidden');
    const pn = $('pip-name');
    if (pn) pn.textContent = $('cs-peer-name')?.textContent || '';
    const pv = $('pip-video'), rv = $('video-remote');
    if (pv && rv?.srcObject) { pv.srcObject = rv.srcObject; }
    else { if (pv) pv.style.display = 'none'; }
    const pm = $('pip-mute');
    if (pm) pm.classList.toggle('muted', _muted);
  }

  function restore() {
    _minimized = false;
    $('call-pip')?.classList.add('hidden');
    if (_state === 'active') {
      $('call-screen')?.classList.remove('hidden');
      _show();
    }
  }

  function _syncPipTimer() {
    if (!_minimized) return;
    const el = $('pip-timer');
    if (el) {
      const m = String(Math.floor(_secs / 60)).padStart(2, '0');
      const s = String(_secs % 60).padStart(2, '0');
      el.textContent = `${m}:${s}`;
    }
  }

  /* ── Init ── */
  function init() {
    $('call-btn-audio')?.addEventListener('click',  () => startCall('audio'));
    $('call-btn-video')?.addEventListener('click',  () => startCall('video'));
    $('call-btn-end')?.addEventListener('click',    () => hangup());
    $('call-btn-accept')?.addEventListener('click', () => acceptCall());
    $('call-btn-reject')?.addEventListener('click', () => rejectCall());
    $('call-btn-mute')?.addEventListener('click',   () => toggleMute());
    $('call-btn-cam')?.addEventListener('click',    () => toggleCamera());
    $('call-btn-share')?.addEventListener('click',  () => toggleShare());
    $('cs-minimize')?.addEventListener('click',     () => minimize());
    $('pip-expand')?.addEventListener('click',      () => restore());
    $('pip-end')?.addEventListener('click',         () => hangup());
    $('pip-mute')?.addEventListener('click', () => {
      toggleMute();
      $('pip-mute')?.classList.toggle('muted', _muted);
    });

    $('call-screen')?.addEventListener('click', () => { if (_state === 'active') _show(); });

    RTCManager.on('track', (event, fromPeerId) => onRemoteTrack(event, fromPeerId));

    const ctrl = $('cs-controls'), top = document.querySelector('.cs-topbar');
    if (ctrl) ctrl.style.transition = 'opacity .3s';
    if (top)  top.style.transition  = 'opacity .3s';
  }

  return { init, startCall, hangup, handleSignal, onRemoteTrack, minimize, restore };
})();

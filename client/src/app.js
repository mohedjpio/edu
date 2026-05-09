'use strict';
(async () => {
  const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/signal`;
  let _mode      = 'p2p';
  let _myPeerId  = null;
  let _isInit    = false;
  let _connCount = 0;
  let _peerNames = {};
  let _myName    = 'You';
  let _roomId    = null;

  window._getMode      = () => _mode;
  window._getPeerName  = (id) => _peerNames[id] || 'Peer';
  window._updatePeerName = (id, name) => {
    _peerNames[id] = name;
    const meInit = document.getElementById('cha-initial-me');
    const meName = document.getElementById('chn-name-me');
    if (meInit) meInit.textContent = (_myName[0] || 'Y').toUpperCase();
    if (meName) meName.textContent = _myName;
    UI.updatePeerList(_peerNames);
  };

  UI.initTabs();

  /* ── Online/offline status ── */
  function updateNetMode() {
    UI.setMode(navigator.onLine ? 'Online' : 'Offline', navigator.onLine ? 'green' : 'amber');
  }
  updateNetMode();
  window.addEventListener('online',  updateNetMode);
  window.addEventListener('offline', updateNetMode);

  /* ── Signaling handlers ── */
  SignalingSocket.on('joined', async (msg) => {
    _myPeerId = msg.peerId;
    _mode     = msg.mode || 'p2p';
    _roomId   = msg.roomId;
    RTCManager.init(msg.peerId, msg.iceServers, _mode);

    const existing = msg.peers || [];
    console.log(`[app] joined room=${msg.roomId} mode=${_mode} peers=${existing.length}`);

    if (!window._eduReady && window.EduModule) {
      const eduRole = document.getElementById('edu-role-select')?.value || 'student';
      window.EduModule.init(_myPeerId, msg.name || _myName, eduRole);
      window._eduReady = true;
    }

    if (_mode === 'group') {
      for (const p of existing) {
        _peerNames[p.id] = p.name;
        if (_myPeerId < p.id) {
          console.log(`[app] group: offering ${p.id.slice(0,6)}`);
          await RTCManager.createOffer(p.id);
        }
      }
    } else {
      if (_isInit) {
        for (const p of existing) {
          _peerNames[p.id] = p.name;
          await RTCManager.createOffer(p.id);
        }
      }
    }
  });

  SignalingSocket.on('peer_joined', async (msg) => {
    _peerNames[msg.peerId] = msg.name || `Peer ${Object.keys(_peerNames).length + 1}`;
    UI.setPeerStatus(`${_peerNames[msg.peerId]} joining…`);
    UI.updatePeerList(_peerNames);

    if (!window._eduReady && window.EduModule) {
      const eduRole = document.getElementById('edu-role-select')?.value || 'student';
      window.EduModule.init(_myPeerId, msg.name || _myName, eduRole);
      window._eduReady = true;
    }

    if (_mode === 'group') {
      if (_myPeerId < msg.peerId) {
        await RTCManager.createOffer(msg.peerId);
      }
    } else {
      if (_isInit) {
        await RTCManager.createOffer(msg.peerId);
      }
    }
  });

  SignalingSocket.on('offer', (msg) => {
    if (!_peerNames[msg.from]) _peerNames[msg.from] = 'Peer';
    RTCManager.handleOffer(msg.payload, msg.from);
  });
  SignalingSocket.on('answer',        (msg) => RTCManager.handleAnswer(msg.payload, msg.from));
  SignalingSocket.on('ice-candidate', (msg) => RTCManager.handleIceCandidate(msg.payload, msg.from));
  SignalingSocket.on('call-signal',   (msg) => CallModule.handleSignal(msg.payload, msg.from));

  window._routeEduMsg = (from, data) => {
    if (window.EduModule && data?.type === 'edu:msg') EduModule.onPeerData(from, data);
  };

  SignalingSocket.on('peer_left', (msg) => {
    const name = _peerNames[msg.peerId] || 'A peer';
    RTCManager.closePeer(msg.peerId);
    delete _peerNames[msg.peerId];
    _connCount = Math.max(0, _connCount - 1);
    UI.updatePeerList(_peerNames);
    UI.updateConnCount(_connCount);
    ChatModule.appendSystem(`${name} left the room.`);
    UI.toast(`${name} disconnected`, 'error');
    if (_mode === 'p2p' && _connCount === 0) {
      CallModule.hangup('peer_left');
      Channels.reset();
      UI.showScreen('connect-screen');
    }
  });

  SignalingSocket.on('error', (msg) => {
    console.error('[app] server error:', msg);
    UI.toast(msg.message || 'Server error', 'error');
  });

  /* ── WebRTC events ── */
  RTCManager.on('channel', (ch, fromPeerId) => {
    console.log(`[app] channel label=${ch.label} peer=${fromPeerId.slice(0,8)}`);
    Channels.register(ch, fromPeerId);
  });

  RTCManager.on('track',             (event, peerId) => CallModule.onRemoteTrack(event, peerId));
  RTCManager.on('peer_disconnected', (_pid)           => { /* handled via peer_left */ });

  RTCManager.on('peer_connected', (peerId) => {
    _connCount++;

    // Send hello message to exchange names over data channel
    const _sendHello = (attempts) => {
      if (Channels.isOpenTo(peerId, Channels.LABELS.CHAT)) {
        Channels.sendToJSON(peerId, Channels.LABELS.CHAT, { type: 'hello', name: _myName });
      } else if (attempts > 0) {
        setTimeout(() => _sendHello(attempts - 1), 150);
      }
    };
    _sendHello(20); // up to 20 × 150ms = 3s

    const name = _peerNames[peerId] || 'Peer';
    console.log(`[app] CONNECTED peer=${peerId.slice(0,8)} name=${name} total=${_connCount}`);

    const meInit = document.getElementById('cha-initial-me');
    const meName = document.getElementById('chn-name-me');
    if (meInit) meInit.textContent = (_myName[0] || 'Y').toUpperCase();
    if (meName) meName.textContent = _myName;

    UI.updateConnCount(_connCount);
    UI.updatePeerList(_peerNames);

    if (_connCount === 1) {
      UI.showScreen('app-screen');
      UI.toast(_mode === 'group' ? `${name} joined the group` : 'Connected — secure P2P');
      ChatModule.appendSystem(_mode === 'group' ? `${name} joined.` : 'Connected. Start chatting!');
    } else {
      UI.toast(`${name} joined`);
      ChatModule.appendSystem(`${name} joined.`);
    }
  });

  /* ── Create room ── */
  document.getElementById('btn-create')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('my-name-input');
    _isInit    = true;
    _connCount = 0;
    _myName    = nameInput?.value.trim() || 'Host';

    let roomId;
    try {
      const res = await fetch('/api/room', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ mode: _mode }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      ({ roomId } = await res.json());
    } catch (e) {
      UI.toast('Failed to create room — check your connection: ' + e.message, 'error');
      return;
    }

    await QRModule.generate(roomId, _mode);
    UI.setPeerStatus(_mode === 'group' ? 'Waiting for members…' : 'Waiting for peer to scan…');

    SignalingSocket.connect(WS_URL, () => {
      SignalingSocket.send({ type: 'join', roomId, mode: _mode, name: _myName });
    });
  });

  /* ── Join room ── */
  function joinRoom(rawId) {
    _isInit    = false;
    _connCount = 0;
    _myName    = document.getElementById('my-name-input')?.value.trim() || 'Guest';

    let roomId = (rawId || '').trim();
    try {
      const u = new URL(roomId);
      const m = u.searchParams.get('mode');
      if (m === 'group' || m === 'p2p') _mode = m;
      roomId = u.searchParams.get('room') || roomId;
    } catch (_) {}

    if (!roomId) { UI.toast('Enter a room URL or ID', 'error'); return; }

    UI.setPeerStatus('Connecting…');
    SignalingSocket.connect(WS_URL, () => {
      SignalingSocket.send({ type: 'join', roomId, name: _myName });
    });
  }

  document.getElementById('btn-join')?.addEventListener('click', () =>
    joinRoom(document.getElementById('room-input').value));
  document.getElementById('room-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom(document.getElementById('room-input').value);
  });

  /* ── Disconnect ── */
  function doDisconnect() {
    _connCount = 0;
    _isInit    = false;
    CallModule.hangup('disconnect');
    SignalingSocket.send({ type: 'leave' });
    RTCManager.closeAll();
    SignalingSocket.disconnect();
    Channels.reset();
    _peerNames = {};
    _roomId    = null;
    UI.showScreen('connect-screen');
    UI.showModeSelect();
  }

  document.getElementById('btn-disconnect')?.addEventListener('click',     doDisconnect);
  document.getElementById('btn-disconnect-mob')?.addEventListener('click', doDisconnect);

  /* ── Mode selection ── */
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      _mode = card.dataset.mode;
      document.getElementById('create-section')?.classList.remove('hidden');
    });
  });

  /* ── Pricing toggle ── */
  document.getElementById('tab-monthly')?.addEventListener('click', () => {
    document.getElementById('tab-monthly')?.classList.add('active');
    document.getElementById('tab-yearly')?.classList.remove('active');
    const el = document.getElementById('pro-price'); if (el) el.textContent = '9';
  });
  document.getElementById('tab-yearly')?.addEventListener('click', () => {
    document.getElementById('tab-yearly')?.classList.add('active');
    document.getElementById('tab-monthly')?.classList.remove('active');
    const el = document.getElementById('pro-price'); if (el) el.textContent = '7';
  });

  /* ── Init modules ── */
  ChatModule.init(() => _mode, () => _myName, () => _peerNames);
  FilesModule.init(() => _mode);
  ClipboardModule.init();
  CallModule.init();

  window._eduReady = false;

  /* ── Auto-join from QR link ── */
  const urlRoom = QRModule.getRoomFromUrl();
  if (urlRoom) {
    UI.showScreen('connect-screen');
    const ri = document.getElementById('room-input');
    if (ri) ri.value = urlRoom;
    UI.showJoinPanel();
    setTimeout(() => joinRoom(urlRoom), 150);
  }
})();

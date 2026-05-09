'use strict';
// RTCManager — mesh P2P + Group, data channels + audio/video tracks
// Mobile-hardened: ICE restart, connection failure retry, proper state tracking

window.RTCManager = (() => {
  let _iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  let _myPeerId   = null;
  let _mode       = 'p2p';
  const _cbs      = {};
  const _pcs      = {};       // peerId → RTCPeerConnection
  const _pending  = {};       // peerId → queued ICE candidates
  let _fired      = {};       // guard duplicate peer_connected per peer
  let _iceTimers  = {};       // peerId → ICE restart retry timer

  function on(ev, fn)     { _cbs[ev] = fn; }
  function emit(ev, ...a) { if (_cbs[ev]) _cbs[ev](...a); }

  function init(myPeerId, servers, mode) {
    _myPeerId = myPeerId;
    _mode     = mode || 'p2p';
    if (servers && servers.length) _iceServers = servers;
    // Clean up any existing connections
    Object.values(_pcs).forEach(pc => { try { pc.close(); } catch(_) {} });
    for (const k in _pcs)      delete _pcs[k];
    for (const k in _pending)  delete _pending[k];
    for (const k in _iceTimers){ clearTimeout(_iceTimers[k]); delete _iceTimers[k]; }
    _fired = {};
  }

  function _getOrCreate(remotePeerId) {
    if (_pcs[remotePeerId]) return _pcs[remotePeerId];

    const pc = new RTCPeerConnection({
      iceServers: _iceServers,
      // Mobile: use unified plan (default in modern browsers)
      // bundlePolicy: maximize-bundle helps on cellular
      bundlePolicy:    'max-bundle',
      rtcpMuxPolicy:   'require',
      iceTransportPolicy: 'all',  // try direct first, TURN as fallback
    });

    _pcs[remotePeerId]    = pc;
    _pending[remotePeerId] = [];

    // ── ICE candidate ──────────────────────────────────────────────────────
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        SignalingSocket.send({ type: 'ice-candidate', payload: candidate, to: remotePeerId });
      }
    };

    // Log ICE gathering for debugging on mobile
    pc.onicegatheringstatechange = () => {
      console.log(`[rtc] ICE gathering ${remotePeerId.slice(0,8)}: ${pc.iceGatheringState}`);
    };

    // ── Connection state ───────────────────────────────────────────────────
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      console.log(`[rtc] connectionState ${remotePeerId.slice(0,8)}: ${s}`);
      if ((s === 'connected' || s === 'completed') && !_fired[remotePeerId]) {
        _fired[remotePeerId] = true;
        clearTimeout(_iceTimers[remotePeerId]);
        emit('peer_connected', remotePeerId);
      }
      if (s === 'failed') {
        console.warn(`[rtc] connection failed for ${remotePeerId.slice(0,8)} — attempting ICE restart`);
        _iceRestart(remotePeerId);
      }
      if (s === 'disconnected') {
        // Give 5s before treating as failed (mobile network flap)
        _iceTimers[remotePeerId] = setTimeout(() => {
          const cur = _pcs[remotePeerId]?.connectionState;
          if (cur === 'disconnected' || cur === 'failed') {
            console.warn(`[rtc] still disconnected after 5s — ICE restart`);
            _iceRestart(remotePeerId);
          }
        }, 5000);
      }
      if (s === 'closed') {
        delete _fired[remotePeerId];
        clearTimeout(_iceTimers[remotePeerId]);
        emit('peer_disconnected', remotePeerId);
      }
    };

    // ── ICE connection state (fallback for browsers that update this but not connectionState) ──
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log(`[rtc] iceConnectionState ${remotePeerId.slice(0,8)}: ${s}`);
      if ((s === 'connected' || s === 'completed') && !_fired[remotePeerId]) {
        _fired[remotePeerId] = true;
        clearTimeout(_iceTimers[remotePeerId]);
        emit('peer_connected', remotePeerId);
      }
      if (s === 'failed') _iceRestart(remotePeerId);
      if (s === 'disconnected') {
        // Browsers sometimes self-recover — wait before restarting
        _iceTimers[remotePeerId] = setTimeout(() => {
          if (_pcs[remotePeerId]?.iceConnectionState === 'disconnected') {
            _iceRestart(remotePeerId);
          }
        }, 4000);
      }
    };

    // Answerer receives data channels
    pc.ondatachannel = (e) => {
      console.log(`[rtc] ondatachannel label=${e.channel.label} from=${remotePeerId.slice(0,8)}`);
      emit('channel', e.channel, remotePeerId);
    };

    pc.ontrack = (e) => emit('track', e, remotePeerId);

    return pc;
  }

  // ── ICE restart (recovers from mobile network switches) ─────────────────
  async function _iceRestart(remotePeerId) {
    const pc = _pcs[remotePeerId];
    if (!pc || pc.signalingState === 'closed') return;
    // Only initiator restarts (lower UUID = initiator in group, original offerer in p2p)
    if (_myPeerId > remotePeerId && _mode === 'group') return;
    try {
      console.log(`[rtc] ICE restart → ${remotePeerId.slice(0,8)}`);
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      SignalingSocket.send({ type: 'offer', payload: offer, to: remotePeerId });
    } catch (e) {
      console.warn('[rtc] ICE restart failed:', e);
    }
  }

  // ── Initiator: create channels then offer ────────────────────────────────
  async function createOffer(remotePeerId) {
    const pc = _getOrCreate(remotePeerId);

    // Create data channels
    ['chat', 'file', 'clipboard'].forEach(label => {
      const ch = pc.createDataChannel(label, {
        ordered:  true,
        // Mobile: larger maxRetransmits for lossy connections
      });
      emit('channel', ch, remotePeerId);
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    SignalingSocket.send({ type: 'offer', payload: offer, to: remotePeerId });
    console.log(`[rtc] sent offer to ${remotePeerId.slice(0,8)}`);
  }

  // ── Answerer: handle offer ───────────────────────────────────────────────
  async function handleOffer(offer, fromPeerId) {
    const pc = _getOrCreate(fromPeerId);

    // Handle glare (both sides offer simultaneously)
    if (pc.signalingState !== 'stable') {
      if (pc.signalingState === 'have-local-offer') {
        // Rollback our local offer, accept remote
        try {
          await pc.setLocalDescription({ type: 'rollback' });
        } catch(e) {
          console.warn('[rtc] rollback failed:', e.message);
          return;
        }
      } else {
        console.warn(`[rtc] handleOffer: unexpected state ${pc.signalingState}`);
        return;
      }
    }

    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    // Flush buffered ICE candidates
    for (const c of (_pending[fromPeerId] || [])) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {
        console.warn('[rtc] flush ICE error:', e.message);
      }
    }
    _pending[fromPeerId] = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    SignalingSocket.send({ type: 'answer', payload: answer, to: fromPeerId });
    console.log(`[rtc] sent answer to ${fromPeerId.slice(0,8)}`);
  }

  // ── Handle answer ─────────────────────────────────────────────────────────
  async function handleAnswer(answer, fromPeerId) {
    const pc = _pcs[fromPeerId];
    if (!pc) return;
    // Ignore if not waiting for answer (could be ICE restart answer)
    if (pc.signalingState !== 'have-local-offer') {
      console.warn(`[rtc] handleAnswer: state=${pc.signalingState}, ignoring`);
      return;
    }
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    for (const c of (_pending[fromPeerId] || [])) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) {
        console.warn('[rtc] flush ICE error:', e.message);
      }
    }
    _pending[fromPeerId] = [];
  }

  // ── Handle ICE candidate ─────────────────────────────────────────────────
  async function handleIceCandidate(candidate, fromPeerId) {
    const pc = _pcs[fromPeerId];
    if (!pc) return;
    if (!pc.remoteDescription || pc.remoteDescription.type === '') {
      // Queue until remote description is set
      (_pending[fromPeerId] = _pending[fromPeerId] || []).push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch(e) {
      // Ignore benign errors (end-of-candidates, duplicate)
      if (!e.message.includes('Unknown ufrag') && !e.message.includes('ICE candidate')) {
        console.warn('[rtc] addIceCandidate error:', e.message);
      }
    }
  }

  function closePeer(peerId) {
    const pc = _pcs[peerId];
    if (pc) { try { pc.close(); } catch(_) {} delete _pcs[peerId]; }
    delete _pending[peerId];
    delete _fired[peerId];
    clearTimeout(_iceTimers[peerId]);
    delete _iceTimers[peerId];
  }

  function closeAll() { Object.keys(_pcs).forEach(closePeer); }

  function connectedPeers() { return Object.keys(_pcs); }

  function sendToAll(data) {
    try { Channels.broadcast('chat', JSON.stringify(data)); } catch(_) {}
  }
  function sendToPeer(peerId, data) {
    try { Channels.sendTo(peerId, 'chat', JSON.stringify(data)); } catch(_) {}
  }

  return {
    on, init,
    createOffer, handleOffer, handleAnswer, handleIceCandidate,
    closePeer, closeAll, connectedPeers,
    sendToAll, sendToPeer,
    _pcs,
    get mode() { return _mode; },
  };
})();

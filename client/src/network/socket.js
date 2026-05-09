'use strict';
window.SignalingSocket = (() => {
  let ws          = null;
  let handlers    = {};
  let reconnTimer = null;
  let reconnDelay = 1500;
  let _url        = null;
  let _onOpen     = null;
  let _stopped    = false;
  let _joined     = false;

  function connect(url, onOpen) {
    if (ws) {
      ws.onclose = null; ws.onerror = null;
      try { ws.close(1000, 'reconnect'); } catch(_) {}
      ws = null;
    }
    clearTimeout(reconnTimer);
    _stopped    = false;
    _joined     = false;
    _url        = url;
    _onOpen     = onOpen;
    reconnDelay = 1500;
    _open();
  }

  function _open() {
    if (_stopped) return;
    try { ws = new WebSocket(_url); } catch(e) {
      console.error('[ws] bad URL:', e); return;
    }

    // Mobile: shorter timeout — cellular can be slow to establish
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('[ws] connected');
      reconnDelay = 1500;
      if (_onOpen) _onOpen();
    };

    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'joined') _joined = true;
      const fn = handlers[m.type];
      if (fn) fn(m); else console.warn('[ws] unhandled:', m.type);
    };

    ws.onclose = (ev) => {
      if (_stopped) return;
      console.log('[ws] closed', ev.code, ev.reason);
      // Don't auto-reconnect after successful join (prevents ghost peer bug)
      if (_joined) {
        console.log('[ws] joined — no auto-reconnect');
        return;
      }
      // Retry with backoff for pre-join failures
      if (ev.code !== 1000) {
        reconnTimer = setTimeout(() => {
          reconnDelay = Math.min(reconnDelay * 1.6, 12000);
          _open();
        }, reconnDelay);
      }
    };

    ws.onerror = (e) => {
      console.warn('[ws] error:', e.message || e);
    };
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload)); return true;
    }
    return false;
  }

  function on(type, fn) { handlers[type] = fn; }

  function disconnect() {
    _stopped = true;
    _joined  = false;
    clearTimeout(reconnTimer);
    if (ws) { ws.onclose = null; ws.onerror = null; ws.close(1000, 'disconnect'); ws = null; }
  }

  function isConnected() { return !!(ws && ws.readyState === WebSocket.OPEN); }

  return { connect, send, on, disconnect, isConnected };
})();

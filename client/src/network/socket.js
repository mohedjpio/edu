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
      try { ws.close(1000, 'reconnect'); } catch (_) {}
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
    try { ws = new WebSocket(_url); }
    catch (e) { console.error('[ws] bad URL:', e); return; }

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('[ws] connected to', _url);
      reconnDelay = 1500;
      if (_onOpen) _onOpen();
    };

    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      console.log('[ws] recv:', m.type);
      if (m.type === 'joined') _joined = true;
      const fn = handlers[m.type];
      if (fn) fn(m);
      else console.warn('[ws] unhandled msg type:', m.type);
    };

    ws.onclose = (ev) => {
      if (_stopped) return;
      console.log('[ws] closed', ev.code, ev.reason || '');
      if (_joined) {
        console.log('[ws] already joined — no auto-reconnect (prevents ghost peer)');
        return;
      }
      // Retry with backoff for pre-join connection failures
      if (ev.code !== 1000) {
        console.log(`[ws] retrying in ${reconnDelay}ms`);
        reconnTimer = setTimeout(() => {
          reconnDelay = Math.min(reconnDelay * 1.6, 12000);
          _open();
        }, reconnDelay);
      }
    };

    ws.onerror = (e) => {
      // WebSocket error events don't expose useful messages in browsers
      console.warn('[ws] error event (check network/server)');
    };
  }

  function send(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    console.warn('[ws] send failed — not open. readyState:', ws?.readyState);
    return false;
  }

  function on(type, fn) { handlers[type] = fn; }

  function disconnect() {
    _stopped = true;
    _joined  = false;
    clearTimeout(reconnTimer);
    if (ws) {
      ws.onclose = null; ws.onerror = null;
      ws.close(1000, 'disconnect');
      ws = null;
    }
  }

  function isConnected() { return !!(ws && ws.readyState === WebSocket.OPEN); }

  return { connect, send, on, disconnect, isConnected };
})();

'use strict';
// Channels — named DataChannels registry
// In p2p mode: ONE remote peer, stored under that peer's actual server-assigned UUID.
// In group mode: multiple peers, each with their own UUID.
// No magic '__p2p__' constant — always use the real peerId.

window.Channels = (() => {
  const _ch = {};   // `${peerId}::${label}` → RTCDataChannel
  const _fn = {};   // label → (data, fromPeerId) => void

  function _key(peerId, label) { return `${peerId}::${label}`; }

  function onMessage(label, fn) { _fn[label] = fn; }

  function _setup(ch, peerId) {
    const label = ch.label;
    const key   = _key(peerId, label);
    if (label === 'file') {
      ch.binaryType = 'arraybuffer';
      ch.bufferedAmountLowThreshold = 256 * 1024;
    }
    ch.onopen    = () => console.log(`[ch] OPEN  ${String(peerId).slice(0,8)}::${label}`);
    ch.onclose   = () => { console.log(`[ch] CLOSE ${String(peerId).slice(0,8)}::${label}`); delete _ch[key]; };
    ch.onerror   = e => console.error(`[ch] ERR   ${String(peerId).slice(0,8)}::${label}`, e);
    ch.onmessage = e => { const fn = _fn[label]; if (fn) fn(e.data, peerId); };
    _ch[key] = ch;
    console.log(`[ch] REGISTERED ${String(peerId).slice(0,8)}::${label} state=${ch.readyState}`);
  }

  function register(ch, peerId) { _setup(ch, peerId); }
  function receive(ch, peerId)  { _setup(ch, peerId); }

  // Get the raw RTCDataChannel for a specific peer (needed for backpressure)
  function getRawChannel(label, peerId) {
    return _ch[_key(peerId, label)] || null;
  }

  // Send to one specific peer by their UUID
  function sendTo(peerId, label, data) {
    const ch = _ch[_key(peerId, label)];
    if (!ch || ch.readyState !== 'open') {
      console.warn(`[ch] sendTo: ${String(peerId).slice(0,8)}::${label} not open (${ch ? ch.readyState : 'missing'})`);
      return false;
    }
    ch.send(data);
    return true;
  }

  // Send to ALL open channels with this label (group broadcast)
  function broadcast(label, data) {
    let sent = 0;
    for (const [key, ch] of Object.entries(_ch)) {
      if (!key.endsWith(`::${label}`)) continue;
      if (ch.readyState !== 'open') continue;
      ch.send(data); sent++;
    }
    return sent > 0;
  }

  // Convenience: send to first open channel (works for both p2p and group)
  function sendAny(label, data) {
    for (const [key, ch] of Object.entries(_ch)) {
      if (!key.endsWith(`::${label}`)) continue;
      if (ch.readyState !== 'open') continue;
      ch.send(data);
      return true;
    }
    console.warn(`[ch] sendAny: no open channel for label '${label}'`);
    return false;
  }

  // In p2p mode — send to the single connected peer (finds it automatically)
  function send(label, data)    { return sendAny(label, data); }
  function sendJSON(label, obj) { return send(label, JSON.stringify(obj)); }

  function broadcastJSON(label, obj)               { return broadcast(label, JSON.stringify(obj)); }
  function sendToJSON(peerId, label, obj)           { return sendTo(peerId, label, JSON.stringify(obj)); }

  function isOpen(label) {
    for (const [key, ch] of Object.entries(_ch)) {
      if (key.endsWith(`::${label}`) && ch.readyState === 'open') return true;
    }
    return false;
  }

  function isOpenTo(peerId, label) {
    const ch = _ch[_key(peerId, label)];
    return !!(ch && ch.readyState === 'open');
  }

  function openPeers(label) {
    return Object.entries(_ch)
      .filter(([k, ch]) => k.endsWith(`::${label}`) && ch.readyState === 'open')
      .map(([k]) => k.split('::')[0]);
  }

  function reset() {
    for (const k in _ch) delete _ch[k];
    console.log('[ch] all channels reset');
  }

  const LABELS = { CHAT: 'chat', FILE: 'file', CLIPBOARD: 'clipboard' };

  // Expose all registered keys for debugging
  function debug() { return Object.keys(_ch); }

  return {
    register, receive, onMessage, getRawChannel,
    send, sendJSON, sendTo, sendToJSON,
    broadcast, broadcastJSON, sendAny,
    isOpen, isOpenTo, openPeers, reset, debug,
    LABELS,
  };
})();

'use strict';
const { WebSocketServer } = require('ws');
const session = require('./session');
const { HEARTBEAT_INTERVAL_MS, ICE_SERVERS } = require('./config');

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(peers, payload, excludeId) {
  for (const p of peers) if (p.id !== excludeId) send(p.ws, payload);
}

function handleJoin(ws, msg, state) {
  const roomId = msg.roomId || session.generateRoomId();
  const { peerId, error } = session.joinRoom(roomId, ws, msg.name, msg.mode);

  if (error) {
    const room = session.getRoom(roomId);
    const max  = room ? (room.mode === 'group' ? 500 : 2) : 2;
    send(ws, { type: 'error', code: error, message: `Room is full (max ${max} peers).` });
    return;
  }

  state.peerId = peerId;
  state.roomId = roomId;

  const room   = session.getRoom(roomId);
  const others = session.getRoomPeers(peerId);

  send(ws, {
    type:       'joined',
    roomId,
    peerId,
    mode:       room.mode,
    iceServers: ICE_SERVERS,   // send TURN credentials to client
    peers:      others.map(p => ({ id: p.id, name: p.name })),
  });

  broadcast(others, { type: 'peer_joined', peerId, name: room.peers.get(peerId)?.name }, null);
  console.log(`[signal] ${peerId.slice(0,8)} joined ${room.mode} room ${roomId.slice(0,8)} (${others.length + 1} peers)`);
}

// Generic relay — offer/answer/ice-candidate/call-signal all use the same path
function handleRelay(ws, msg, state) {
  if (!state.peerId) { send(ws, { type: 'error', code: 'not_joined' }); return; }
  const room   = session.getRoom(state.roomId);
  if (!room) return;
  const others = session.getRoomPeers(state.peerId);
  if (!others.length) return;

  const out = { ...msg, from: state.peerId };

  if (msg.to) {
    // Directed (group mode, ICE restart)
    const target = room.peers.get(msg.to);
    if (target) send(target.ws, out);
  } else {
    // Broadcast (p2p — only one other peer anyway)
    broadcast(others, out, state.peerId);
  }
}

function handleLeave(ws, state) {
  if (!state.peerId) return;
  const peerId  = state.peerId;
  const roomId  = state.roomId;
  session.leaveRoom(peerId);
  const room = session.getRoom(roomId);
  if (room) broadcast([...room.peers.values()], { type: 'peer_left', peerId }, null);
  console.log(`[signal] ${peerId.slice(0,8)} left`);
  state.peerId = null;
  state.roomId = null;
}

function setupSignaling(server) {
  const wss = new WebSocketServer({ server, path: '/signal' });

  wss.on('connection', (ws, req) => {
    const state = { peerId: null, roomId: null, alive: true };

    // ── Heartbeat — detects dead mobile connections ───────────────────────
    ws.on('pong', () => { state.alive = true; });
    const hb = setInterval(() => {
      if (!state.alive) {
        console.log(`[signal] dead connection — terminating ${state.peerId?.slice(0,8) || 'unknown'}`);
        ws.terminate();
        return;
      }
      state.alive = false;
      ws.ping();
    }, HEARTBEAT_INTERVAL_MS);

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'join':          handleJoin(ws, msg, state);    break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
        case 'call-signal':   handleRelay(ws, msg, state);   break;
        case 'leave':         handleLeave(ws, state);         break;
        default:
          send(ws, { type: 'error', code: 'unknown_type', message: `Unknown type: ${msg.type}` });
      }
    });

    ws.on('close', (code, reason) => {
      clearInterval(hb);
      handleLeave(ws, state);
      console.log(`[signal] ws closed ${code} ${reason?.toString?.() || ''}`);
    });

    ws.on('error', e => console.error('[signal] ws error:', e.message));
    console.log(`[signal] connection from ${req.socket.remoteAddress}`);
  });

  // Send pings to all clients
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  console.log('[signal] ready on /signal');
  return wss;
}

module.exports = { setupSignaling };

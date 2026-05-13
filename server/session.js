'use strict';
const { v4: uuidv4 } = require('uuid');
const { SESSION_TTL_MS } = require('./config');

const MAX_P2P   = 2;
const MAX_GROUP = 500;

// Room = { id, mode:'p2p'|'group', peers: Map<peerId,{id,ws,name,joinedAt}>, createdAt, lastActivity }
const rooms    = new Map();
const peerRoom = new Map(); // peerId → roomId

function now() { return Date.now(); }
function touch(r) { r.lastActivity = now(); }

function createRoom(roomId, mode) {
  const room = { id:roomId, mode: mode||'p2p', peers: new Map(), createdAt:now(), lastActivity:now() };
  rooms.set(roomId, room);
  return room;
}

function generateRoomId() { return uuidv4(); }

function joinRoom(roomId, ws, name, mode, role) {
  let room = rooms.get(roomId);
  if (!room) room = createRoom(roomId, mode || 'p2p');

  const max = room.mode === 'group' ? MAX_GROUP : MAX_P2P;
  if (room.peers.size >= max) return { peerId:null, error:'room_full' };

  const peerId = uuidv4();
  room.peers.set(peerId, {
    id:       peerId,
    ws,
    name:     name || `User ${room.peers.size+1}`,
    role:     role || 'student',   // store role so it can be relayed
    joinedAt: now(),
  });
  peerRoom.set(peerId, roomId);
  touch(room);
  return { peerId, error:null };
}

function leaveRoom(peerId) {
  const roomId = peerRoom.get(peerId);
  if (!roomId) return null;
  const room = rooms.get(roomId);
  if (room) {
    room.peers.delete(peerId);
    touch(room);
    if (room.peers.size === 0) rooms.delete(roomId);
  }
  peerRoom.delete(peerId);
  return roomId;
}

function getRoom(roomId)        { return rooms.get(roomId) || null; }
function getPeerRoom(peerId)    { return rooms.get(peerRoom.get(peerId)) || null; }
function getRoomPeers(peerId)   {
  const r = getPeerRoom(peerId);
  return r ? [...r.peers.values()].filter(p => p.id !== peerId) : [];
}

function stats() { return { rooms: rooms.size, peers: peerRoom.size }; }

// TTL sweep
setInterval(() => {
  const cut = now() - SESSION_TTL_MS;
  for (const [id, room] of rooms) {
    if (room.lastActivity < cut) {
      for (const p of room.peers.values()) {
        try { p.ws.close(1001, 'session_expired'); } catch(_) {}
        peerRoom.delete(p.id);
      }
      rooms.delete(id);
      console.log(`[session] expired room ${id.slice(0,8)}`);
    }
  }
}, 60_000);

module.exports = { generateRoomId, joinRoom, leaveRoom, getRoom, getPeerRoom, getRoomPeers, stats };

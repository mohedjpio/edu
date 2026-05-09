'use strict';
const http    = require('http');
const path    = require('path');
const express = require('express');
const cors    = require('cors');
const { setupSignaling }      = require('./signaling');
const { startDiscovery, getLanIp } = require('./discovery');
const session = require('./session');
const { PORT, PUBLIC_URL, ICE_SERVERS } = require('./config');

const app = express();
app.use(cors({ origin:'*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));

function getAppUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  return `http://${getLanIp()}:${PORT}`;
}

app.get('/health', (_,res) => res.json({ status:'ok', appUrl:getAppUrl(), ...session.stats(), ts:Date.now() }));
app.get('/api/ice-servers', (_,res) => res.json({ iceServers:ICE_SERVERS }));

// Create room — now accepts mode: 'p2p' | 'group'
app.post('/api/room', (req, res) => {
  res.json({ roomId: session.generateRoomId(), mode: req.body?.mode || 'p2p' });
});

app.get('/api/server-info', (_,res) => {
  res.json({
    appUrl:       getAppUrl(),
    isProduction: !!PUBLIC_URL,
    lanUrl:       `http://${getLanIp()}:${PORT}`,
  });
});

// FIX 3: sendBeacon endpoint for clean disconnect on page refresh/close
app.post('/api/leave', express.text({ type: '*/*' }), (req, res) => {
  // The body is the JSON {type:'leave'} — we just need to acknowledge it.
  // Actual peer cleanup is handled server-side when the WebSocket closes.
  res.sendStatus(204);
});

const server = http.createServer(app);
setupSignaling(server);

server.listen(PORT, '0.0.0.0', () => {
  const url = getAppUrl();
  console.log(`\n  SmartShare 🚀  ${url}\n`);
  if (!PUBLIC_URL) startDiscovery(PORT);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

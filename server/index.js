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
app.use(express.json({ limit:'16kb' }));   // prevent oversized JSON payloads

function getAppUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  return `http://${getLanIp()}:${PORT}`;
}

// ── API routes MUST be registered BEFORE express.static ──────────────────
// Static middleware intercepts any path that matches a file on disk.
// Registering API routes first ensures /health, /api/* are never shadowed.

app.get('/health', (_,res) => res.json({ status:'ok', appUrl:getAppUrl(), ...session.stats(), ts:Date.now() }));
app.get('/api/ice-servers', (_,res) => res.json({ iceServers:ICE_SERVERS }));

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

// sendBeacon endpoint for clean disconnect on page refresh/close
app.post('/api/leave', express.text({ type: '*/*' }), (req, res) => {
  res.sendStatus(204);
});

// 404 handler for unknown /api/* routes (returns JSON, not HTML)
app.use('/api', (_,res) => res.status(404).json({ error:'not_found' }));

// ── Static files — registered AFTER all API routes ────────────────────────
app.use(express.static(path.join(__dirname, '..', 'client')));

const server = http.createServer(app);
setupSignaling(server);

server.listen(PORT, '0.0.0.0', () => {
  const url = getAppUrl();
  console.log(`\n  SmartShare 🚀  ${url}\n`);
  if (!PUBLIC_URL) startDiscovery(PORT);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));

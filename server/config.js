'use strict';

function detectPublicUrl() {
  const e = process.env;
  if (e.PUBLIC_URL)              return e.PUBLIC_URL.replace(/\/$/, '');
  if (e.RAILWAY_PUBLIC_DOMAIN)   return `https://${e.RAILWAY_PUBLIC_DOMAIN}`;
  if (e.RENDER_EXTERNAL_URL)     return e.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  if (e.FLY_APP_NAME)            return `https://${e.FLY_APP_NAME}.fly.dev`;
  if (e.HEROKU_APP_DEFAULT_DOMAIN_NAME) return `https://${e.HEROKU_APP_DEFAULT_DOMAIN_NAME}`;
  if (e.VERCEL_URL)              return `https://${e.VERCEL_URL}`;
  return null;
}

// ── ICE servers ───────────────────────────────────────────────────────────────
// STUN only works when both peers are on open/cone NAT (same WiFi / most desktop).
// Phones on 4G/5G are often behind Symmetric NAT — STUN fails, TURN is required.
//
// Free public TURN options (no signup):
//   - metered.ca free tier  (set TURN_USERNAME + TURN_CREDENTIAL env vars)
//   - Twilio TURN           (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN)
//   - openrelay.metered.ca  (limited bandwidth but works for testing)
//
// For production, deploy your own coturn server or use a paid TURN service.

function buildIceServers() {
  const servers = [
    // Multiple STUN servers for reliability
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    // Free public STUN from Cloudflare
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Free public STUN from Twilio
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];

  const e = process.env;

  // ── Option 1: Metered.ca TURN (set TURN_USERNAME + TURN_CREDENTIAL) ──
  if (e.TURN_USERNAME && e.TURN_CREDENTIAL) {
    const u = e.TURN_USERNAME;
    const c = e.TURN_CREDENTIAL;
    const h = e.TURN_HOST || 'openrelay.metered.ca';
    servers.push(
      { urls: `turn:${h}:80`,   username: u, credential: c },
      { urls: `turn:${h}:443`,  username: u, credential: c },
      { urls: `turns:${h}:443`, username: u, credential: c },  // TLS
    );
    console.log(`[ice] TURN configured via ${h}`);
  }

  // ── Option 2: Open Relay (free, limited — good for testing phone↔phone) ──
  // Always include as fallback — no credentials needed
  servers.push(
    { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  );

  return servers;
}

module.exports = {
  PORT:            process.env.PORT || 3000,
  PUBLIC_URL:      detectPublicUrl(),
  WS_PATH:         '/signal',
  ICE_SERVERS:     buildIceServers(),
  SESSION_TTL_MS:       30 * 60 * 1000,
  HEARTBEAT_INTERVAL_MS: 25000,
};

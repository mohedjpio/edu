// server/discovery.js — LAN peer discovery for offline mode
// Announces the SmartShare server on the local network via mDNS (Bonjour/Avahi).
// Peers on the same Wi-Fi / hotspot can find each other without internet.

const os = require('os');

/**
 * Get the machine's primary LAN IP (first non-loopback IPv4).
 */
function getLanIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Try to start mDNS advertisement.
 * Gracefully skips if the 'bonjour-service' package isn't installed
 * (it requires native binaries that may not be present in all environments).
 */
function startDiscovery(port) {
  const ip = getLanIp();
  console.log(`[discovery] LAN IP: ${ip}:${port}`);

  try {
    const Bonjour = require('bonjour-service');
    const bonjour = new Bonjour();
    const service = bonjour.publish({
      name: 'SmartShare',
      type: 'http',
      port,
      txt: { version: '1.0', path: '/' },
    });

    service.on('up', () => {
      console.log(`[discovery] mDNS service published — smartshare.local:${port}`);
    });

    process.on('exit', () => bonjour.unpublishAll());
    return { ip, mdns: true };
  } catch (err) {
    // bonjour not available — LAN peers can still connect by IP
    console.log(`[discovery] mDNS unavailable (${err.message}). LAN peers connect via IP: ${ip}:${port}`);
    return { ip, mdns: false };
  }
}

module.exports = { startDiscovery, getLanIp };

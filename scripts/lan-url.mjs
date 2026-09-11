// Print the URL(s) other devices on this WiFi/LAN should open to reach the game.
//
// Used by `npm run lan` (standalone) and printed at the top of `npm run dev:lan`
// so you can hand the address to a phone / second laptop without hunting for
// your IP. It picks the first non-internal IPv4 on an up interface and prints
// the shared development or production server URL.

import os from 'node:os';

const SERVER_PORT = process.env.PORT || '8787';

function lanIPv4s() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // Skip common virtual / VPN ranges so we surface the real WiFi/LAN IP.
      if (/^(vmnet|vboxnet|utun|bridge|llw|awdl)/i.test(name)) continue;
      out.push(a.address);
    }
  }
  return out;
}

const ips = lanIPv4s();
const mode = process.argv.includes('--server') ? 'server' : 'dev';
const port = SERVER_PORT;

if (ips.length === 0) {
  console.log('[lan] No LAN IPv4 found — are you connected to WiFi/Ethernet?');
} else {
  const label = mode === 'server' ? 'single-port (built client + server)' : 'dev (Vite hot reload)';
  console.log(`\n  Elyxion on your LAN — ${label}`);
  console.log('  Open this on any device on the same WiFi:\n');
  for (const ip of ips) console.log(`    →  http://${ip}:${port}`);
  if (ips.length > 1) console.log('\n  (multiple addresses — try them in order if one fails)');
  console.log('\n  On macOS the first connection may prompt to allow incoming');
  console.log('  connections — click Allow. Same-subnet only; no internet exposure.\n');
}

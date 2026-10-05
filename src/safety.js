const dns = require('node:dns').promises;
const net = require('node:net');

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const v6 = ip.toLowerCase();
  if (v6 === '::1' || v6 === '::') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80')) return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
}

async function assertPublicUrl(rawUrl, { allowLocal = false, lookup = dns.lookup } = {}) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }
  if (allowLocal) return url;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new Error(`Refusing to audit a local host: ${host}`);
  }
  const addresses = net.isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  for (const { address } of addresses) {
    if (isPrivateIP(address)) {
      throw new Error(`Refusing to audit ${host}: resolves to a private address (${address})`);
    }
  }
  return url;
}

module.exports = { assertPublicUrl, isPrivateIP };

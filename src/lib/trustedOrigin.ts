/**
 * Origins that are safe for application-controlled network requests.
 *
 * HTTPS is required across the public Internet. Plain HTTP is also accepted on
 * local RFC1918/link-local networks: browser-facing support endpoints carry no
 * control bearer token, and the actual peer/data plane is Noise/E2EE protected.
 * Identity backup/restore remains separately restricted to the loopback native
 * bridge.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host === 'tauri.localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }

  const octets = host.split('.');
  if (octets.length !== 4 || octets[0] !== '127') {
    return false;
  }
  return octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

export function isPrivateNetworkHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (isLoopbackHostname(host)) return true;
  const octets = host.split('.');
  if (octets.length === 4
    && octets.every(octet => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)) {
    const [a, b] = octets.map(Number);
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127);
  }
  // IPv6 unique-local fc00::/7 and link-local fe80::/10.
  return /^(?:fc|fd)[0-9a-f]{2}:/.test(host)
    || /^fe[89ab][0-9a-f]:/.test(host);
}

export function isTrustedHttpOrigin(url: URL): boolean {
  if (url.username || url.password) {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && isPrivateNetworkHostname(url.hostname);
}

export function parseTrustedHttpOrigin(raw: string): URL | null {
  try {
    const parsed = new URL(raw.trim());
    return isTrustedHttpOrigin(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

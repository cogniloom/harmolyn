import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTrustedHttpOrigin } from './trustedOrigin';

describe('native support endpoint and CSP compatibility', () => {
  it('accepts explicitly configured private HTTP nodes without extending the public HTTP boundary', () => {
    for (const origin of ['http://192.168.1.20:7000', 'http://10.0.0.1:7000', 'http://172.16.0.2:7000', 'http://[fd00::1]:7000', 'http://127.0.0.1:7000', 'http://localhost:7000']) {
      assert.ok(parseTrustedHttpOrigin(origin), origin);
    }
    for (const origin of ['http://203.0.113.1:7000', 'http://example.com', 'http://172.32.0.1:7000', 'http://192.169.1.20:7000', 'ftp://192.168.1.20', 'https://user:secret@example.com', 'http://user:secret@192.168.1.20']) {
      assert.equal(parseTrustedHttpOrigin(origin), null, origin);
    }
    assert.ok(parseTrustedHttpOrigin('https://example.com'));
  });

  it('allows LAN connection schemes while retaining executable-content restrictions and signed updates', () => {
    // CSP cannot express arbitrary private IPv4/IPv6 CIDRs. The HTTP origin
    // validator and native-only identity bridge remain the trust boundaries.
    const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const directives = new Map<string, string[]>(config.app.security.csp.split(';').filter(Boolean).map((value: string) => {
      const [name, ...sources] = value.trim().split(/\s+/);
      return [name, sources];
    }));
    for (const scheme of ['http:', 'https:', 'ws:', 'wss:', 'ipc:']) {
      assert.ok(directives.get('connect-src')?.includes(scheme), scheme);
    }
    assert.deepEqual(directives.get('script-src'), ["'self'"]);
    assert.deepEqual(directives.get('object-src'), ["'none'"]);
    assert.deepEqual(directives.get('form-action'), ["'self'"]);
    assert.deepEqual(directives.get('worker-src'), ["'self'", 'blob:']);
    assert.equal(config.bundle.createUpdaterArtifacts, true);
    assert.ok(config.plugins.updater.pubkey.length > 80);
    assert.ok(config.plugins.updater.endpoints.every((value: string) => value.startsWith('https://')));
  });
});

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { createObjectUrlLease } from '../previews';

describe('decrypted object URL ownership', () => {
  function fixture() {
    const created: string[] = []; const revoked: string[] = [];
    const lease = createObjectUrlLease({ createObjectURL: () => { const url = `blob:test-${created.length}`; created.push(url); return url; }, revokeObjectURL: url => { revoked.push(url); } });
    return { lease, created, revoked };
  }
  it('prevents duplicate submissions and late completion after unmount', () => {
    const { lease, created } = fixture(); const token = lease.begin()!;
    assert.equal(lease.begin(), null); lease.dispose();
    assert.equal(lease.isCurrent(token), false); assert.equal(lease.complete(token, new Blob()), null); assert.equal(created.length, 0);
  });
  it('revokes ready previews exactly once and permits retry after dismissal', () => {
    const { lease, created, revoked } = fixture(); const token = lease.begin()!;
    assert.equal(lease.complete(token, new Blob()), 'blob:test-0');
    lease.release(); lease.release(); assert.deepEqual(revoked, ['blob:test-0']);
    const retry = lease.begin()!; assert.equal(lease.complete(token, new Blob()), null);
    lease.complete(retry, new Blob()); lease.dispose(); assert.deepEqual(revoked, created);
  });
  it('survives StrictMode effect cleanup/setup without reviving old requests', () => {
    const { lease } = fixture(); const old = lease.begin()!; lease.dispose(); lease.activate();
    assert.equal(lease.complete(old, new Blob()), null); assert.notEqual(lease.begin(), null);
  });
});


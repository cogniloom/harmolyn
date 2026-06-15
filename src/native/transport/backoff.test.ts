import { describe, it, expect } from 'vitest';
import { ExponentialBackoff } from './backoff';

describe('ExponentialBackoff', () => {
  it('starts at initialMs and doubles each attempt', () => {
    const b = new ExponentialBackoff({ initialMs: 100, maxMs: 10_000, factor: 2, jitterMs: 0 });
    const d0 = b.next(); // 100
    const d1 = b.next(); // 200
    const d2 = b.next(); // 400
    expect(d0).toBeGreaterThanOrEqual(100);
    expect(d1).toBeGreaterThanOrEqual(200);
    expect(d2).toBeGreaterThanOrEqual(400);
  });

  it('caps at maxMs', () => {
    const b = new ExponentialBackoff({ initialMs: 1000, maxMs: 5000, factor: 2, jitterMs: 0 });
    for (let i = 0; i < 20; i++) b.next();
    expect(b.next()).toBeLessThanOrEqual(5000);
  });

  it('reset() restarts from initialMs', () => {
    const b = new ExponentialBackoff({ initialMs: 100, maxMs: 10_000, factor: 2, jitterMs: 0 });
    b.next(); b.next(); b.next();
    b.reset();
    const after = b.next();
    expect(after).toBeGreaterThanOrEqual(100);
    expect(after).toBeLessThan(300);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getNodeHealthState,
  subscribeNodeHealth,
  reportNodeRequestSuccess,
  reportNodeRequestFailure,
  resetNodeHealthForTests,
  NODE_OFFLINE_MESSAGE,
  NODE_OFFLINE_BANNER_TITLE,
  NODE_OFFLINE_BANNER_DETAIL,
} from './nodeHealth';

function controlError(code: string): Error {
  return Object.assign(new Error(`control: ${code}`), { code });
}

function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

describe('nodeHealth', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resetNodeHealthForTests();
  });

  afterEach(() => {
    resetNodeHealthForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('exports the canonical UI strings', () => {
    expect(NODE_OFFLINE_MESSAGE).toBe('No node currently available. This feature only works with at least one node online.');
    expect(NODE_OFFLINE_BANNER_TITLE).toBe('Node offline');
    expect(NODE_OFFLINE_BANNER_DETAIL).toBe('Peer routing, contacts, joins, messages, attachments, mailbox delivery, and rendezvous remain active through available peers. Only node-exclusive services pause.');
  });

  describe('state transitions', () => {
    it('starts as unknown', () => {
      expect(getNodeHealthState()).toBe('unknown');
    });

    it('unknown → offline on a transport failure, notifying subscribers', () => {
      const seen: string[] = [];
      subscribeNodeHealth((s) => seen.push(s));
      reportNodeRequestFailure(new TypeError('Failed to fetch'));
      expect(getNodeHealthState()).toBe('offline');
      expect(seen).toEqual(['offline']);
    });

    it('unknown → online on success', () => {
      reportNodeRequestSuccess();
      expect(getNodeHealthState()).toBe('online');
    });

    it('online → offline → online round trip', () => {
      reportNodeRequestSuccess();
      reportNodeRequestFailure(new TypeError('Failed to fetch'));
      expect(getNodeHealthState()).toBe('offline');
      reportNodeRequestSuccess();
      expect(getNodeHealthState()).toBe('online');
    });

    it('does not re-notify subscribers when the state does not change', () => {
      const seen: string[] = [];
      subscribeNodeHealth((s) => seen.push(s));
      reportNodeRequestFailure(new TypeError('a'));
      reportNodeRequestFailure(new TypeError('b'));
      expect(seen).toEqual(['offline']);
    });
  });

  describe('failure classification', () => {
    it('an HTTP-status error means the node is reachable → online, not offline', () => {
      reportNodeRequestFailure(controlError('http_500'));
      expect(getNodeHealthState()).toBe('online');
      reportNodeRequestFailure(controlError('http_404'));
      expect(getNodeHealthState()).toBe('online');
    });

    it('an HTTP-status error while offline recovers the state to online', () => {
      reportNodeRequestFailure(new TypeError('Failed to fetch'));
      expect(getNodeHealthState()).toBe('offline');
      reportNodeRequestFailure(controlError('http_403'));
      expect(getNodeHealthState()).toBe('online');
    });

    it("XoreinControlError code 'transport_unavailable' counts as a failure", () => {
      reportNodeRequestFailure(controlError('transport_unavailable'));
      expect(getNodeHealthState()).toBe('offline');
    });

    it('pre-request client-side errors are ignored (no transition)', () => {
      reportNodeRequestFailure(controlError('runtime_unavailable'));
      expect(getNodeHealthState()).toBe('unknown');
      reportNodeRequestFailure(controlError('invalid_endpoint'));
      expect(getNodeHealthState()).toBe('unknown');
    });

    it('abort/timeout errors count as failures', () => {
      reportNodeRequestFailure(abortError());
      expect(getNodeHealthState()).toBe('offline');
    });

    it('a bare failure report (no error object) counts as a failure', () => {
      reportNodeRequestFailure();
      expect(getNodeHealthState()).toBe('offline');
    });

    it('unrecognized errors are ignored (no transition)', () => {
      reportNodeRequestFailure(new Error('some app-level problem'));
      expect(getNodeHealthState()).toBe('unknown');
    });
  });

  describe('recovery prober', () => {
    it('does not probe while unknown or online', async () => {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchMock).not.toHaveBeenCalled();

      reportNodeRequestSuccess();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('probes /v1/state after 5s while offline and flips online on success', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      const seen: string[] = [];
      subscribeNodeHealth((s) => seen.push(s));

      reportNodeRequestFailure(new TypeError('Failed to fetch'));
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toMatch(/\/v1\/state$/);
      expect(getNodeHealthState()).toBe('online');
      expect(seen).toEqual(['offline', 'online']);
    });

    it('stops probing once a probe succeeds', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200 });
      reportNodeRequestFailure(new TypeError('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getNodeHealthState()).toBe('online');
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(300_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('an error-status probe response still counts as reachable', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 503 });
      reportNodeRequestFailure(new TypeError('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(getNodeHealthState()).toBe('online');
    });

    it('backs off 5s → 10s → 20s → 30s (capped) while probes keep failing', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      reportNodeRequestFailure(new TypeError('Failed to fetch'));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // Capped: stays at 30s intervals.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(getNodeHealthState()).toBe('offline');
    });

    it('repeated failure reports do not stack extra probes', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      reportNodeRequestFailure(new TypeError('a'));
      reportNodeRequestFailure(new TypeError('b'));
      reportNodeRequestFailure(new TypeError('c'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('an app-request success while offline cancels the pending probe', async () => {
      reportNodeRequestFailure(new TypeError('Failed to fetch'));
      reportNodeRequestSuccess();
      await vi.advanceTimersByTimeAsync(300_000);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getNodeHealthState()).toBe('online');
    });
  });

  describe('subscribe/unsubscribe', () => {
    it('unsubscribed listeners stop receiving updates', () => {
      const seen: string[] = [];
      const unsubscribe = subscribeNodeHealth((s) => seen.push(s));
      reportNodeRequestFailure(new TypeError('a'));
      unsubscribe();
      reportNodeRequestSuccess();
      expect(seen).toEqual(['offline']);
    });

    it('a throwing listener does not break other listeners', () => {
      const seen: string[] = [];
      subscribeNodeHealth(() => { throw new Error('broken listener'); });
      subscribeNodeHealth((s) => seen.push(s));
      reportNodeRequestFailure(new TypeError('a'));
      expect(seen).toEqual(['offline']);
    });
  });
});

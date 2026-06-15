import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readBrowserAuthContext,
} from "./authPreview";

afterEach(() => {
  vi.restoreAllMocks();
  const windowRecord = window as unknown as Record<string, unknown>;
  delete windowRecord.__HARMOLYN_XOREIN_RUNTIME__;
  delete windowRecord.__HARMOLYN_XOREIN_CONTROL_READY__;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("authPreview", () => {
  it("falls back cleanly when storage is blocked", () => {
    const storageError = new DOMException("Blocked", "SecurityError");
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw storageError;
    });
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw storageError;
    });

    expect(readBrowserAuthContext()).toEqual({
      runtimeSnapshot: null,
      hasRuntimeIdentity: false,
      hasControlEndpoint: false,
      hasControlBridge: false,
      identityLabel: 'local runtime',
    });
  });

  it("reports a ready control bridge from a non-secret native readiness signal", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      identity: { peer_id: 'peer-local' },
      control_endpoint: 'http://127.0.0.1:7711',
      settings: {},
    };
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_CONTROL_READY__ = true;

    expect(readBrowserAuthContext()).toMatchObject({
      hasRuntimeIdentity: true,
      hasControlEndpoint: true,
      hasControlBridge: true,
      identityLabel: 'peer-local',
    });
  });

  it("does not treat persisted browser tokens as control bridge readiness", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      identity: { peer_id: 'peer-local' },
      control_endpoint: 'http://127.0.0.1:7711',
      settings: {},
    };
    window.localStorage.setItem('harmolyn:xorein:control-token', 'persisted-token');

    expect(readBrowserAuthContext()).toMatchObject({
      hasRuntimeIdentity: true,
      hasControlEndpoint: true,
      hasControlBridge: false,
      identityLabel: 'peer-local',
    });
  });

  it("drops malformed nested settings values from browser auth context", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      identity: { peer_id: 'peer-local' },
      settings: {
        control_endpoint: ' https://127.0.0.1:7711 ',
        control_endpoint_alt: { bad: true },
        empty: '   ',
      },
    };

    expect(readBrowserAuthContext()).toMatchObject({
      hasRuntimeIdentity: true,
      hasControlEndpoint: true,
      identityLabel: 'peer-local',
    });
  });

  it("keeps the first normalized browser runtime setting when keys collide", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      identity: { peer_id: 'peer-local' },
      settings: {
        ' control_endpoint ': ' http://127.0.0.1:7711 ',
        control_endpoint: ' http://127.0.0.1:7999 ',
      },
    };

    const context = readBrowserAuthContext();
    expect(context.runtimeSnapshot?.settings).toEqual({
      control_endpoint: 'http://127.0.0.1:7711',
    });
  });

  it("treats empty settings objects as absent", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      settings: {},
    };

    expect(readBrowserAuthContext()).toEqual({
      runtimeSnapshot: null,
      hasRuntimeIdentity: false,
      hasControlEndpoint: false,
      hasControlBridge: false,
      identityLabel: 'local runtime',
    });
  });

  it("falls back to nested settings when the top-level control endpoint is malformed", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      identity: { peer_id: 'peer-local' },
      control_endpoint: { bad: true },
      settings: {
        control_endpoint: ' https://127.0.0.1:7711 ',
      },
    };

    expect(readBrowserAuthContext()).toMatchObject({
      hasRuntimeIdentity: true,
      hasControlEndpoint: true,
      identityLabel: 'peer-local',
    });
  });

  it("ignores array-shaped runtime snapshots from globals and storage", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = [];
    window.localStorage.setItem('harmolyn:xorein:runtime', JSON.stringify([]));

    expect(readBrowserAuthContext()).toEqual({
      runtimeSnapshot: null,
      hasRuntimeIdentity: false,
      hasControlEndpoint: false,
      hasControlBridge: false,
      identityLabel: 'local runtime',
    });
  });

  it("ignores runtime objects with a null prototype", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = Object.create(null);

    expect(readBrowserAuthContext()).toEqual({
      runtimeSnapshot: null,
      hasRuntimeIdentity: false,
      hasControlEndpoint: false,
      hasControlBridge: false,
      identityLabel: 'local runtime',
    });
  });

  it("drops malformed nested identity profile fields from browser auth context", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      identity: {
        peer_id: 'peer-local',
        profile: {
          display_name: 123,
          bio: 'connected test user',
        },
      },
      control_endpoint: 'http://127.0.0.1:7711',
      settings: {},
    };

    expect(readBrowserAuthContext()).toMatchObject({
      hasRuntimeIdentity: true,
      hasControlEndpoint: true,
      hasControlBridge: false,
      identityLabel: 'peer-local',
    });
  });

  it("treats display-name-only identities as absent in browser auth context", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      identity: {
        profile: {
          display_name: 'Ada',
        },
      },
      control_endpoint: 'http://127.0.0.1:7711',
      settings: {},
    };

    expect(readBrowserAuthContext()).toMatchObject({
      hasRuntimeIdentity: false,
      hasControlEndpoint: true,
      identityLabel: 'local runtime',
    });
  });

  it("treats runtime snapshots with no usable fields as absent", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      unexpected: { bad: true },
      nested: [],
    };

    expect(readBrowserAuthContext()).toEqual({
      runtimeSnapshot: null,
      hasRuntimeIdentity: false,
      hasControlEndpoint: false,
      hasControlBridge: false,
      identityLabel: 'local runtime',
    });
  });

  it("normalizes runtime snapshot fields before exposing the auth context", () => {
    (window as unknown as Record<string, unknown>).__HARMOLYN_XOREIN_RUNTIME__ = {
      identity: {
        peer_id: 'peer-local',
        profile: {
          display_name: ' Ada ',
        },
      },
      control_endpoint: ' http://127.0.0.1:7711 ',
      settings: {
        control_endpoint: ' http://127.0.0.1:7711 ',
        ignored: { bad: true },
      },
    };

    const context = readBrowserAuthContext();

    expect(context.runtimeSnapshot?.identity?.peer_id).toBe('peer-local');
    expect(context.runtimeSnapshot?.identity?.profile?.display_name).toBe('Ada');
    expect(context.runtimeSnapshot?.control_endpoint).toBe('http://127.0.0.1:7711');
    expect(context.runtimeSnapshot?.settings).toEqual({
      control_endpoint: 'http://127.0.0.1:7711',
    });
    expect(Object.keys(context.runtimeSnapshot ?? {}).sort()).toEqual(['control_endpoint', 'identity', 'settings']);
  });
});

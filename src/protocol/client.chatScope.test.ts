// Regression tests for the HIGH finding: decrypted chat plaintext (channels AND
// Seal DMs) was persisted UNENCRYPTED in localStorage under the chat-scope keys,
// defeating the encrypted-at-rest native store — a stolen device or any local
// reader could recover message history without the account password.
//
// Contract under test:
//   • With an identity-derived cipher configured, chat-scope blobs are AES-GCM
//     encrypted and namespaced per peer id — NO plaintext message body is ever
//     recoverable from browser storage after a write.
//   • Guests (ephemeral mode) leave NOTHING in browser storage at all.
//   • Unconfigured mode (no identity) never writes plaintext either — writes
//     stay in memory; only pre-existing LEGACY plaintext blobs remain readable.
//   • Legacy plaintext blobs are purged the moment persistence is configured.
//   • Blobs are bound to (namespace, scope): another account or another scope
//     cannot read or merge them.
import { afterEach, describe, expect, it } from "vitest";
import {
  configureChatScopePersistence,
  purgeAllPersistedChatScopeState,
  readPersistedChatScopeState,
  writePersistedChatScopeState,
  type PersistedChatScopeState,
} from "./client";

const SECRET = "attack at dawn 0xC0FFEE — seal dm plaintext";
const PREFIX = "harmolyn:xorein:chat-scope:";

const KEY_A = new Uint8Array(32).fill(7);
const KEY_B = new Uint8Array(32).fill(9);

function makeState(content: string): PersistedChatScopeState {
  return {
    version: 1,
    nickname: "Cipher",
    mutedUserIds: [],
    inboxReadIds: [],
    deletedMessageIds: [],
    messages: [{ id: "m1", userId: "peer-remote", content, timestamp: "2026-07-28T10:00:00Z" }],
    threads: {
      "m1": [{ id: "m2", userId: "peer-remote", content: `${content} (thread reply)`, timestamp: "2026-07-28T10:01:00Z" }],
    },
  };
}

function allStoredValues(): string[] {
  const values: string[] = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null) {
        values.push(store.getItem(key) ?? "");
      }
    }
  }
  return values;
}

function storedChatScopeKeys(): string[] {
  const keys: string[] = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX)) {
        keys.push(key);
      }
    }
  }
  return keys;
}

afterEach(() => {
  configureChatScopePersistence(null);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("chat-scope persistence — no plaintext at rest (regression)", () => {
  it("REGRESSION: after a write with the at-rest cipher configured, no plaintext message body is recoverable from browser storage", () => {
    configureChatScopePersistence({ key: KEY_A, namespace: "peer-a" });

    writePersistedChatScopeState("dm-1", makeState(SECRET));

    // Something WAS persisted (the encrypted envelope)…
    const keys = storedChatScopeKeys();
    expect(keys.length).toBe(1);
    const blob = window.localStorage.getItem(keys[0]) ?? "";
    const envelope = JSON.parse(blob) as { v?: number; n?: string; ct?: string };
    expect(envelope.v).toBe(2);
    expect(typeof envelope.n).toBe("string");
    expect(typeof envelope.ct).toBe("string");

    // …but NO stored value anywhere contains the decrypted content.
    for (const value of allStoredValues()) {
      expect(value).not.toContain(SECRET);
      expect(value).not.toContain("thread reply");
      expect(value).not.toContain("Cipher");
    }

    // The rightful owner still reads it back.
    const restored = readPersistedChatScopeState("dm-1");
    expect(restored.messages[0]?.content).toBe(SECRET);
    expect(restored.threads["m1"]?.[0]?.content).toContain("thread reply");
    expect(restored.nickname).toBe("Cipher");
  });

  it("guests (ephemeral mode) leave nothing in browser storage at all", () => {
    configureChatScopePersistence({ ephemeral: true });

    writePersistedChatScopeState("ch-guest", makeState(SECRET));

    expect(storedChatScopeKeys()).toEqual([]);
    for (const value of allStoredValues()) {
      expect(value).not.toContain(SECRET);
    }
    // In-session UX still works from memory.
    expect(readPersistedChatScopeState("ch-guest").messages[0]?.content).toBe(SECRET);
  });

  it("unconfigured mode never writes plaintext to storage (fail closed, memory only)", () => {
    writePersistedChatScopeState("ch-1", makeState(SECRET));

    expect(storedChatScopeKeys()).toEqual([]);
    for (const value of allStoredValues()) {
      expect(value).not.toContain(SECRET);
    }
    expect(readPersistedChatScopeState("ch-1").messages[0]?.content).toBe(SECRET);
  });

  it("purges LEGACY plaintext blobs from localStorage as soon as persistence is configured", () => {
    // Seed a blob in the legacy plaintext format (what older builds wrote).
    window.localStorage.setItem(`${PREFIX}ch-old`, JSON.stringify(makeState(SECRET)));

    configureChatScopePersistence({ key: KEY_A, namespace: "peer-a" });

    expect(window.localStorage.getItem(`${PREFIX}ch-old`)).toBeNull();
    for (const value of allStoredValues()) {
      expect(value).not.toContain(SECRET);
    }
  });

  it("purges LEGACY plaintext blobs when a GUEST configures persistence, and guests cannot read them", () => {
    window.localStorage.setItem(`${PREFIX}ch-old`, JSON.stringify(makeState(SECRET)));

    configureChatScopePersistence({ ephemeral: true });

    expect(window.localStorage.getItem(`${PREFIX}ch-old`)).toBeNull();
    expect(readPersistedChatScopeState("ch-old").messages).toEqual([]);
  });

  it("still READS a pre-existing legacy plaintext blob in unconfigured mode (migration compat)", () => {
    window.localStorage.setItem(`${PREFIX}ch-legacy`, JSON.stringify(makeState("legacy body")));

    expect(readPersistedChatScopeState("ch-legacy").messages[0]?.content).toBe("legacy body");
  });
});

describe("chat-scope persistence — account and scope isolation", () => {
  it("a second account on the same browser cannot read or merge the first account's scope state", () => {
    configureChatScopePersistence({ key: KEY_A, namespace: "peer-a" });
    writePersistedChatScopeState("ch-shared-id", makeState(SECRET));

    // Same scope id, different identity (different key AND namespace).
    configureChatScopePersistence({ key: KEY_B, namespace: "peer-b" });
    expect(readPersistedChatScopeState("ch-shared-id")).toEqual({
      version: 1,
      nickname: "",
      mutedUserIds: [],
      inboxReadIds: [],
      deletedMessageIds: [],
      messages: [],
      threads: {},
    });

    // And peer-b's own writes do not clobber peer-a's blob.
    writePersistedChatScopeState("ch-shared-id", makeState("peer-b content"));
    configureChatScopePersistence({ key: KEY_A, namespace: "peer-a" });
    expect(readPersistedChatScopeState("ch-shared-id").messages[0]?.content).toBe(SECRET);
  });

  it("a blob copied to a different scope's key does not decrypt (AAD binds namespace+scope)", () => {
    configureChatScopePersistence({ key: KEY_A, namespace: "peer-a" });
    writePersistedChatScopeState("ch-src", makeState(SECRET));

    const src = window.localStorage.getItem(`${PREFIX}peer-a:ch-src`);
    expect(src).toBeTruthy();
    window.localStorage.setItem(`${PREFIX}peer-a:ch-dst`, src as string);

    expect(readPersistedChatScopeState("ch-dst").messages).toEqual([]);
  });

  it("returns empty state (not garbage) for a tampered ciphertext", () => {
    configureChatScopePersistence({ key: KEY_A, namespace: "peer-a" });
    writePersistedChatScopeState("ch-t", makeState(SECRET));

    const key = `${PREFIX}peer-a:ch-t`;
    const envelope = JSON.parse(window.localStorage.getItem(key) as string) as { ct: string };
    envelope.ct = `AAAA${envelope.ct.slice(4)}`;
    window.localStorage.setItem(key, JSON.stringify(envelope));

    expect(readPersistedChatScopeState("ch-t").messages).toEqual([]);
  });

  it("configuring persistence clears the in-memory scope cache (no cross-identity leak in one JS context)", () => {
    configureChatScopePersistence({ ephemeral: true });
    writePersistedChatScopeState("ch-mem", makeState(SECRET));
    expect(readPersistedChatScopeState("ch-mem").messages.length).toBe(1);

    configureChatScopePersistence({ ephemeral: true });

    expect(readPersistedChatScopeState("ch-mem").messages).toEqual([]);
  });

  it("purgeAllPersistedChatScopeState removes every chat-scope blob (logout / identity reset)", () => {
    configureChatScopePersistence({ key: KEY_A, namespace: "peer-a" });
    writePersistedChatScopeState("ch-1", makeState(SECRET));
    window.localStorage.setItem(`${PREFIX}ch-legacy`, JSON.stringify(makeState("legacy")));

    purgeAllPersistedChatScopeState();

    expect(storedChatScopeKeys()).toEqual([]);
  });

  it("rejects a weak cipher config (wrong key length) and fails closed to memory-only", () => {
    configureChatScopePersistence({ key: new Uint8Array(16).fill(1), namespace: "peer-a" });

    writePersistedChatScopeState("ch-weak", makeState(SECRET));

    expect(storedChatScopeKeys()).toEqual([]);
    for (const value of allStoredValues()) {
      expect(value).not.toContain(SECRET);
    }
  });
});

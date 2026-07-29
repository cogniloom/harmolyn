// Minimal in-memory IndexedDB fake for unit tests (jsdom has no indexedDB).
// Implements only the surface src/native/identity/storage.ts uses:
//   indexedDB.open(name, v) → onupgradeneeded/onsuccess, db.createObjectStore,
//   db.transaction(store, mode).objectStore(store).{put,get,delete,getAll},
//   request.onsuccess/onerror/result, tx.oncomplete/onerror, db.close().
// Values are held by reference (no structured clone), so non-serializable
// handles like a WebCrypto CryptoKey survive a put/get round-trip — matching
// how the session wrap key is persisted in the real browser.
//
// NOT a test file (vitest only collects *.test.* / *.spec.*); import it from
// tests via installFakeIndexedDB().

type Handler = ((ev: unknown) => void) | null;

class FakeRequest<T = unknown> {
  result: T | undefined = undefined;
  error: Error | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  /** Fire success asynchronously so handlers assigned after the call still run. */
  succeed(value: T): void {
    this.result = value;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }
}

class FakeObjectStore {
  constructor(private readonly data: Map<IDBValidKey, unknown>, private readonly keyPath: string | null) {}

  put(value: unknown, key?: IDBValidKey): FakeRequest {
    const req = new FakeRequest();
    const k = key ?? (this.keyPath ? (value as Record<string, IDBValidKey>)[this.keyPath] : undefined);
    if (k === undefined) throw new Error('fake idb: no key');
    this.data.set(k, value);
    req.succeed(undefined);
    return req;
  }

  get(key: IDBValidKey): FakeRequest {
    const req = new FakeRequest();
    req.succeed(this.data.get(key));
    return req;
  }

  delete(key: IDBValidKey): FakeRequest {
    const req = new FakeRequest();
    this.data.delete(key);
    req.succeed(undefined);
    return req;
  }

  getAll(): FakeRequest<unknown[]> {
    const req = new FakeRequest<unknown[]>();
    req.succeed([...this.data.values()]);
    return req;
  }

  getAllKeys(): FakeRequest<IDBValidKey[]> {
    const req = new FakeRequest<IDBValidKey[]>();
    req.succeed([...this.data.keys()]);
    return req;
  }
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: Handler = null;
  onerror: Handler = null;
  constructor(private readonly db: FakeDatabase) {
    // Operations against the in-memory Map are synchronous; completion just has
    // to fire after the caller's synchronous block (where handlers are set).
    queueMicrotask(() => queueMicrotask(() => this.oncomplete?.({ target: this })));
  }
  objectStore(name: string): FakeObjectStore {
    return this.db.store(name);
  }
}

class FakeDatabase {
  readonly stores = new Map<string, { data: Map<IDBValidKey, unknown>; keyPath: string | null }>();
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };
  createObjectStore(name: string, opts?: { keyPath?: string }): void {
    if (!this.stores.has(name)) this.stores.set(name, { data: new Map(), keyPath: opts?.keyPath ?? null });
  }
  store(name: string): FakeObjectStore {
    const s = this.stores.get(name);
    if (!s) throw new Error(`fake idb: no object store ${name}`);
    return new FakeObjectStore(s.data, s.keyPath);
  }
  transaction(name: string, _mode: 'readonly' | 'readwrite'): FakeTransaction {
    this.store(name); // throw early on unknown store, like the real thing
    return new FakeTransaction(this);
  }
  close(): void { /* no-op */ }
}

const databases = new Map<string, FakeDatabase>();

const fakeIndexedDB = {
  open(name: string, _version?: number) {
    const req = new FakeRequest<FakeDatabase>() as FakeRequest<FakeDatabase> & { onupgradeneeded: Handler };
    req.onupgradeneeded = null;
    const existing = databases.get(name);
    const db = existing ?? new FakeDatabase();
    const isNew = !existing;
    if (isNew) databases.set(name, db);
    queueMicrotask(() => {
      req.result = db;
      if (isNew) req.onupgradeneeded?.({ target: req });
      req.onsuccess?.({ target: req });
    });
    return req;
  },
};

/** Install the fake as globalThis.indexedDB. Call once at module scope of a test file. */
export function installFakeIndexedDB(): void {
  (globalThis as Record<string, unknown>).indexedDB = fakeIndexedDB;
}

/** Drop all fake databases (per-test isolation). */
export function resetFakeIndexedDB(): void {
  databases.clear();
}

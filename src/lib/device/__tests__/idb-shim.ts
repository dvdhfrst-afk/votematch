/**
 * Minimal in-memory IndexedDB shim for the device-store unit tests (no new
 * dependency). Implements ONLY the surface store.ts uses: open (with
 * onupgradeneeded/onsuccess/onerror), a single object store with get/put/delete,
 * and transaction oncomplete/onerror. Data lives in a plain Map per db name so
 * "reopening" the same name sees prior writes, exactly like a real IDB.
 *
 * This is deliberately small and synchronous-underneath: requests resolve via
 * queueMicrotask so the store's promise wrapper (which chains on onsuccess ->
 * tx.oncomplete) behaves as it would against a real browser IDB.
 */

type StoreData = Map<string, unknown>;

// Persistent backing per (dbName -> storeName -> data), so a fresh open sees
// prior writes within one test file run.
const backing = new Map<string, Map<string, StoreData>>();

function getDbBacking(name: string): Map<string, StoreData> {
  let db = backing.get(name);
  if (!db) {
    db = new Map();
    backing.set(name, db);
  }
  return db;
}

/** Clear all backing data — call in beforeEach to isolate tests. */
export function resetShimData(): void {
  backing.clear();
}

interface FakeRequest<T = unknown> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

function makeRequest<T>(getResult: () => T): FakeRequest<T> {
  const req: FakeRequest<T> = {
    result: undefined as unknown as T,
    error: null,
    onsuccess: null,
    onerror: null,
  };
  queueMicrotask(() => {
    try {
      req.result = getResult();
      req.onsuccess?.();
    } catch (e) {
      req.error = e;
      req.onerror?.();
    }
  });
  return req;
}

class FakeObjectStore {
  constructor(
    private data: StoreData,
    private tx: FakeTransaction,
  ) {}

  get(key: string): FakeRequest {
    return makeRequest(() => this.data.get(key));
  }

  put(value: unknown, key: string): FakeRequest {
    return makeRequest(() => {
      this.data.set(key, value);
      return undefined;
    });
  }

  delete(key: string): FakeRequest {
    return makeRequest(() => {
      this.data.delete(key);
      return undefined;
    });
  }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;

  constructor(private store: FakeObjectStore | null) {
    // Fire oncomplete after the current microtask queue drains, so any get/put
    // request's onsuccess (also microtask-scheduled) runs first.
    queueMicrotask(() => {
      queueMicrotask(() => this.oncomplete?.());
    });
  }

  objectStore(): FakeObjectStore {
    if (!this.store) throw new Error('store not created');
    return this.store;
  }
}

class FakeObjectStoreNames {
  constructor(private names: Set<string>) {}
  contains(n: string): boolean {
    return this.names.has(n);
  }
}

class FakeDatabase {
  objectStoreNames: FakeObjectStoreNames;
  constructor(
    private name: string,
    private stores: Map<string, StoreData>,
  ) {
    this.objectStoreNames = new FakeObjectStoreNames(new Set(stores.keys()));
  }

  createObjectStore(name: string): void {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    this.objectStoreNames = new FakeObjectStoreNames(new Set(this.stores.keys()));
  }

  transaction(storeName: string): FakeTransaction {
    const data = this.stores.get(storeName);
    if (!data) {
      const tx = new FakeTransaction(null);
      return tx;
    }
    // Build the tx first so the store can reference it.
    const tx = new FakeTransaction(null as unknown as FakeObjectStore);
    const store = new FakeObjectStore(data, tx);
    (tx as unknown as { store: FakeObjectStore }).store = store;
    return tx;
  }

  close(): void {
    /* no-op */
  }
}

interface FakeOpenRequest {
  result: FakeDatabase;
  error: unknown;
  onupgradeneeded: (() => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
}

export class FakeIDBFactory {
  // Tracks whether a db "version" has been created, to fire onupgradeneeded once.
  private created = new Set<string>();

  open(name: string /* version */): FakeOpenRequest {
    const stores = getDbBacking(name);
    const isNew = !this.created.has(name);
    const db = new FakeDatabase(name, stores);
    const req: FakeOpenRequest = {
      result: db,
      error: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      if (isNew) {
        this.created.add(name);
        req.onupgradeneeded?.();
      }
      req.onsuccess?.();
    });
    return req;
  }
}

/** A fresh factory that persists across opens within one test file run. */
export function makeShimFactory(): IDBFactory {
  return new FakeIDBFactory() as unknown as IDBFactory;
}

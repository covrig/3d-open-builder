/**
 * Tiny IndexedDB key-value helper. IndexedDB stores typed arrays (mesh data)
 * directly and has room for large models, unlike localStorage.
 */
const DB_NAME = '3d-open-builder';
const VERSION = 2;
export type Store = 'clipboard' | 'autosave';
const STORES: Store[] = ['clipboard', 'autosave'];

let opening: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const tx = d.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export const idbGet = <T>(store: Store, key: string) => run<T | undefined>(store, 'readonly', (s) => s.get(key));
export const idbPut = (store: Store, key: string, value: unknown) => run<void>(store, 'readwrite', (s) => s.put(value, key));
export const idbDelete = (store: Store, key: string) => run<void>(store, 'readwrite', (s) => s.delete(key));
export const idbKeys = (store: Store) => run<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys());

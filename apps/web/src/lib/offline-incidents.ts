import type { CreateIncidentRequest } from "@cmc/contracts";

/**
 * Offline incident queue (P4.4 / ADR-0075). Field users on a flaky link can
 * report incidents while offline — drafts are persisted in IndexedDB and
 * replayed through the normal server action on reconnect (see PwaRegister).
 * Client-only (uses `indexedDB`).
 */
const DB_NAME = "cmc-offline";
const STORE = "incidents";
const VERSION = 1;

export type QueuedIncident = {
  id: number;
  input: CreateIncidentRequest;
  queuedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function queueIncident(input: CreateIncidentRequest): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).add({ input, queuedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function listQueuedIncidents(): Promise<QueuedIncident[]> {
  const db = await openDb();
  try {
    return await new Promise<QueuedIncident[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as QueuedIncident[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function removeQueuedIncident(id: number): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function countQueuedIncidents(): Promise<number> {
  const db = await openDb();
  try {
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

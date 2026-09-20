type Entry = { vector: number[]; expiresAt: number };

type QueryVectorGlobal = typeof globalThis & {
  __rpgQueryVectorCache?: QueryVectorCache;
};

export class QueryVectorCache {
  private readonly ready = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<number[]>>();
  private readonly maxEntries: number;
  private readonly maxPendingEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { maxEntries?: number; maxPendingEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? 128;
    this.maxPendingEntries = options.maxPendingEntries ?? this.maxEntries;
    this.ttlMs = options.ttlMs ?? 120_000;
    this.now = options.now ?? Date.now;
  }

  async get(key: string, load: () => Promise<number[]>, options: { waitMs?: number } = {}): Promise<number[]> {
    const now = this.now();
    const cached = this.ready.get(key);
    if (cached && cached.expiresAt > now) return cached.vector;
    if (cached) this.ready.delete(key);
    const current = this.pending.get(key);
    if (current) {
      try {
        return await this.waitFor(current, options.waitMs);
      } catch {
        // A speculative batch owns a short deadline. Once it fails, an actual
        // retrieval gets to retry with its own remaining request budget.
        if (this.pending.get(key) === current) this.pending.delete(key);
        return this.get(key, load, options);
      }
    }

    const promise = load().then(vector => {
      this.store(key, vector);
      return vector;
    }).finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  async prewarm(keys: readonly string[], loadBatch: (keys: string[]) => Promise<number[][]>, limit = 3): Promise<void> {
    const unique = [...new Set(keys)].slice(0, Math.max(0, limit));
    const capacity = Math.max(0, this.maxPendingEntries - this.pending.size);
    const missing = unique.filter(key => {
      const cached = this.ready.get(key);
      if (cached && cached.expiresAt > this.now()) return false;
      if (cached) this.ready.delete(key);
      return !this.pending.has(key);
    }).slice(0, capacity);
    if (!missing.length) return;

    let resolveBatch!: (vectors: number[][]) => void;
    let rejectBatch!: (error: unknown) => void;
    const batchResult = new Promise<number[][]>((resolve, reject) => { resolveBatch = resolve; rejectBatch = reject; });
    const perKey = missing.map((key, index) => {
      const promise = batchResult.then(vectors => {
        const vector = vectors[index];
        if (!vector) throw new Error("INVALID_VECTOR_RESPONSE");
        this.store(key, vector);
        return vector;
      }).finally(() => {
        if (this.pending.get(key) === promise) this.pending.delete(key);
      });
      this.pending.set(key, promise);
      return promise;
    });
    try {
      const vectors = await loadBatch(missing);
      if (vectors.length !== missing.length) throw new Error("INVALID_VECTOR_RESPONSE");
      resolveBatch(vectors);
      await Promise.all(perKey);
    } catch (error) {
      rejectBatch(error);
      await Promise.allSettled(perKey);
      throw error;
    }
  }

  private store(key: string, vector: number[]) {
    this.ready.delete(key);
    while (this.ready.size >= this.maxEntries) this.ready.delete(this.ready.keys().next().value!);
    this.ready.set(key, { vector, expiresAt: this.now() + this.ttlMs });
  }

  private async waitFor(promise: Promise<number[]>, waitMs?: number): Promise<number[]> {
    if (waitMs === undefined) return promise;
    if (waitMs <= 0) throw new Error("QUERY_VECTOR_WAIT_TIMEOUT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<number[]>((_, reject) => { timer = setTimeout(() => reject(new Error("QUERY_VECTOR_WAIT_TIMEOUT")), waitMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

const sharedGlobal = globalThis as QueryVectorGlobal;
export const queryVectorCache = sharedGlobal.__rpgQueryVectorCache ??= new QueryVectorCache();

export function buildMemoryQuery(action: string, currentLocation: string, lastNarration: string): string {
  return `${action.trim()}. Локация: ${currentLocation}. ${lastNarration.slice(0, 240)}`;
}

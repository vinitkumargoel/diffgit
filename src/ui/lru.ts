/** Tiny insertion-ordered LRU over a plain Map (T4.2: `fileDiffs` cache, max 200 entries). */
export class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(readonly max: number) {}

  /** Read without touching recency: for selectors, which React/zustand re-run on every update. */
  peek(key: K): V | undefined {
    return this.map.get(key);
  }
  /** Read and mark as most recently used. */
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
  }
  delete(key: K): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
  /** Shallow copy so React sees a new reference after mutation. */
  clone(): Lru<K, V> {
    const c = new Lru<K, V>(this.max);
    for (const [k, v] of this.map) c.map.set(k, v);
    return c;
  }
}

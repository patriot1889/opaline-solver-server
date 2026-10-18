export class Cache<T> {
  private items = new Map<string, { value: T; expires: number }>();
  constructor(private max: number, private ttl: number) {}
  get(key: string): T | undefined {
    const item = this.items.get(key);
    if (!item) return;
    this.items.delete(key);
    if (item.expires <= Date.now()) return;
    this.items.set(key, item);
    return item.value;
  }
  set(key: string, value: T, ttl = this.ttl): void {
    this.items.delete(key);
    this.items.set(key, { value, expires: Date.now() + ttl });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
  }
  delete(key: string): void { this.items.delete(key); }
  clear(): void { this.items.clear(); }
}

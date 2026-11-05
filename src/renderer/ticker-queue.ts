export class BoundedTickerQueue<T> {
  private readonly values: T[] = [];
  private readonly maximum: number;

  constructor(maximum: number) {
    this.maximum = Math.max(1, Math.floor(maximum));
  }

  enqueue(value: T): T | undefined {
    const dropped = this.values.length >= this.maximum ? this.values.shift() : undefined;
    this.values.push(value);
    return dropped;
  }

  dequeue(): T | undefined {
    return this.values.shift();
  }

  remove(predicate: (value: T) => boolean): number {
    const before = this.values.length;
    let write = 0;
    for (const value of this.values) {
      if (!predicate(value)) this.values[write++] = value;
    }
    this.values.length = write;
    return before - write;
  }

  clear(): void {
    this.values.length = 0;
  }

  toArray(): T[] {
    return [...this.values];
  }

  get size(): number {
    return this.values.length;
  }
}

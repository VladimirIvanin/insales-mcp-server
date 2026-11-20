/** Tracks MCP calls so shared storage stays open until handlers have finished. */
export class ActiveCalls {
  private readonly pending = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(private readonly parent?: ActiveCalls) {}

  get size() {
    return this.pending.size;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error('MCP application is stopping');
    return this.track(this.parent ? this.parent.run(work) : work());
  }

  async track<T>(call: Promise<T>): Promise<T> {
    this.pending.add(call);
    try {
      return await call;
    } finally {
      this.pending.delete(call);
    }
  }

  async drain() {
    this.stopping = true;
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

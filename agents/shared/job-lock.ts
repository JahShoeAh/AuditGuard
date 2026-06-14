export class JobLockManager {
  private locks = new Map<string, Promise<void>>();

  async withLock<T>(jobKey: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any in-flight operation
    const prevLock = this.locks.get(jobKey) ?? Promise.resolve();

    let resolve: () => void;
    const newLock = new Promise<void>(r => { resolve = r; });
    this.locks.set(jobKey, newLock);

    try {
      await prevLock;
      return await fn();
    } finally {
      resolve!();
      this.locks.delete(jobKey);
    }
  }
}

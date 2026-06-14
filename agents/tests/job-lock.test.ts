import { describe, it, expect } from "vitest";
import { JobLockManager } from "../shared/job-lock.js";

describe("JobLockManager", () => {
  it("prevents concurrent execution for the same job", async () => {
    const manager = new JobLockManager();
    const executionOrder: number[] = [];
    const jobKey = "job123";

    const task1 = manager.withLock(jobKey, async () => {
      executionOrder.push(1);
      await new Promise(resolve => setTimeout(resolve, 50));
      executionOrder.push(2);
    });

    // Start task2 immediately - it should wait for task1
    const task2 = manager.withLock(jobKey, async () => {
      executionOrder.push(3);
      await new Promise(resolve => setTimeout(resolve, 10));
      executionOrder.push(4);
    });

    await Promise.all([task1, task2]);

    // Verify task1 completed before task2 started
    expect(executionOrder).toEqual([1, 2, 3, 4]);
  });

  it("allows concurrent execution for different jobs", async () => {
    const manager = new JobLockManager();
    const executionOrder: number[] = [];

    const task1 = manager.withLock("job1", async () => {
      executionOrder.push(1);
      await new Promise(resolve => setTimeout(resolve, 50));
      executionOrder.push(2);
    });

    const task2 = manager.withLock("job2", async () => {
      executionOrder.push(3);
      await new Promise(resolve => setTimeout(resolve, 10));
      executionOrder.push(4);
    });

    await Promise.all([task1, task2]);

    // Task2 should complete before task1
    expect(executionOrder).toEqual([1, 3, 4, 2]);
  });

  it("handles errors and cleans up locks", async () => {
    const manager = new JobLockManager();
    const jobKey = "job123";

    // First task throws error
    await expect(
      manager.withLock(jobKey, async () => {
        throw new Error("Test error");
      })
    ).rejects.toThrow("Test error");

    // Second task should still run (lock was cleaned up)
    let executed = false;
    await manager.withLock(jobKey, async () => {
      executed = true;
    });

    expect(executed).toBe(true);
  });

  it("returns value from locked function", async () => {
    const manager = new JobLockManager();
    const result = await manager.withLock("job1", async () => {
      return 42;
    });

    expect(result).toBe(42);
  });
});

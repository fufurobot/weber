/**
 * Per-user resource limits.
 *
 * Without these, "one user runs a fork bomb" is not a hypothetical, and the
 * failure is not graceful: it takes the host down for everybody including the
 * operator. The tests therefore focus on the boundary conditions and on
 * fairness — that one user's usage cannot consume another's allowance.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { LimitError, UserLimiter } from "../src/core/limits";

const MB = 1024 * 1024;

let limiter: UserLimiter;

beforeEach(() => {
  limiter = new UserLimiter({
    maxConcurrent: 2,
    maxDiskBytes: 10 * MB,
    maxNotebookRows: 1000,
    maxActionsPerMinute: 5,
  });
});

describe("concurrency", () => {
  test("allows up to the limit", () => {
    limiter.acquire("alice");
    limiter.acquire("alice");
    // Two slots are held, so the observable fact is that usage is at the limit.
    expect(limiter.inFlight("alice")).toBe(2);
    // ...and a third is refused. The limit is what matters, not the handle.
    expect(() => limiter.acquire("alice")).toThrow(LimitError);
  });

  test("refuses beyond the limit", () => {
    limiter.acquire("alice");
    limiter.acquire("alice");
    expect(() => limiter.acquire("alice")).toThrow(LimitError);
  });

  test("users do not consume each other's concurrency", () => {
    limiter.acquire("alice");
    limiter.acquire("alice");
    // Alice is saturated; Bob must be unaffected.
    expect(() => limiter.acquire("bob")).not.toThrow();
  });

  test("releasing frees a slot", () => {
    const a = limiter.acquire("alice");
    limiter.acquire("alice");
    expect(() => limiter.acquire("alice")).toThrow(LimitError);

    a.release();
    expect(() => limiter.acquire("alice")).not.toThrow();
  });

  test("releasing twice is harmless", () => {
    const a = limiter.acquire("alice");
    a.release();
    a.release();
    // Still exactly one slot in use, so two more acquisitions are possible.
    expect(() => limiter.acquire("alice")).not.toThrow();
    expect(() => limiter.acquire("alice")).not.toThrow();
    expect(() => limiter.acquire("alice")).toThrow(LimitError);
  });

  test("reports current usage", () => {
    expect(limiter.inFlight("alice")).toBe(0);
    const a = limiter.acquire("alice");
    expect(limiter.inFlight("alice")).toBe(1);
    a.release();
    expect(limiter.inFlight("alice")).toBe(0);
  });

  test("runs a function within the limit and releases it afterwards", async () => {
    const result = await limiter.withSlot("alice", async () => 42);
    expect(result).toBe(42);
    expect(limiter.inFlight("alice")).toBe(0);
  });

  test("releases the slot even when the function throws", async () => {
    await expect(
      limiter.withSlot("alice", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // A leak here would permanently reduce the user's allowance.
    expect(limiter.inFlight("alice")).toBe(0);
  });

  test("refuses when saturated even via withSlot", async () => {
    limiter.acquire("alice");
    limiter.acquire("alice");
    await expect(limiter.withSlot("alice", async () => 1)).rejects.toThrow(LimitError);
  });
});

describe("disk quota", () => {
  test("allows a write within quota", () => {
    expect(() => limiter.checkDisk("alice", 1 * MB)).not.toThrow();
  });

  test("refuses a write that would exceed quota", () => {
    expect(() => limiter.checkDisk("alice", 11 * MB)).toThrow(LimitError);
  });

  test("accounts for usage already recorded", () => {
    limiter.recordUsage("alice", 9 * MB);
    expect(() => limiter.checkDisk("alice", 2 * MB)).toThrow(LimitError);
    expect(() => limiter.checkDisk("alice", 1 * MB)).not.toThrow();
  });

  test("usage does not leak between users", () => {
    limiter.recordUsage("alice", 9 * MB);
    expect(() => limiter.checkDisk("bob", 9 * MB)).not.toThrow();
  });

  test("reports remaining space, never negative", () => {
    expect(limiter.remainingDisk("alice")).toBe(10 * MB);
    limiter.recordUsage("alice", 4 * MB);
    expect(limiter.remainingDisk("alice")).toBe(6 * MB);
    limiter.recordUsage("alice", 99 * MB);
    expect(limiter.remainingDisk("alice")).toBe(0);
  });

  test("allows a deletion even when over quota", () => {
    // Otherwise a user who exceeds the quota can never get back under it.
    limiter.recordUsage("alice", 20 * MB);
    expect(() => limiter.checkDisk("alice", -5 * MB)).not.toThrow();
  });
});

describe("action rate limiting", () => {
  test("allows up to the limit within the window", () => {
    for (let i = 0; i < 5; i++) expect(() => limiter.checkRate("alice")).not.toThrow();
  });

  test("refuses beyond the limit", () => {
    for (let i = 0; i < 5; i++) limiter.checkRate("alice");
    expect(() => limiter.checkRate("alice")).toThrow(LimitError);
  });

  test("users have independent allowances", () => {
    for (let i = 0; i < 5; i++) limiter.checkRate("alice");
    expect(() => limiter.checkRate("bob")).not.toThrow();
  });

  test("windows expire so a user is not locked out forever", () => {
    let now = 1_000_000;
    const clocked = new UserLimiter(
      { maxConcurrent: 1, maxDiskBytes: MB, maxNotebookRows: 10, maxActionsPerMinute: 2 },
      () => now,
    );
    clocked.checkRate("alice");
    clocked.checkRate("alice");
    expect(() => clocked.checkRate("alice")).toThrow(LimitError);

    now += 61_000; // window elapsed
    expect(() => clocked.checkRate("alice")).not.toThrow();
  });
});

describe("notebook bounds", () => {
  test("allows a result within the row limit", () => {
    expect(() => limiter.checkNotebook("alice", 500, 10)).not.toThrow();
  });

  test("refuses too many rows", () => {
    expect(() => limiter.checkNotebook("alice", 5000, 10)).toThrow(LimitError);
  });

  test("refuses too many cells", () => {
    expect(() => limiter.checkNotebook("alice", 10, 5000)).toThrow(LimitError);
  });

  test("counts a non-finite row count as a violation, not a pass", () => {
    // Infinity or NaN would slip through a naive `>` comparison.
    expect(() => limiter.checkNotebook("alice", Number.POSITIVE_INFINITY, 1)).toThrow(LimitError);
    expect(() => limiter.checkNotebook("alice", Number.NaN, 1)).toThrow(LimitError);
  });
});

describe("defaults and error shape", () => {
  test("provides sane defaults without configuration", () => {
    const d = new UserLimiter();
    expect(() => d.acquire("alice")).not.toThrow();
  });

  test("LimitError names the limit so the API can explain it", () => {
    limiter.acquire("alice");
    limiter.acquire("alice");
    try {
      limiter.acquire("alice");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LimitError);
      expect((err as LimitError).limit).toBe("concurrent");
      expect((err as Error).message).toMatch(/concurrent/i);
    }
  });

  test("rejects a nonsensical configuration", () => {
    expect(() => new UserLimiter({ maxConcurrent: 0 })).toThrow();
    expect(() => new UserLimiter({ maxDiskBytes: -1 })).toThrow();
    expect(() => new UserLimiter({ maxActionsPerMinute: -5 })).toThrow();
  });
});

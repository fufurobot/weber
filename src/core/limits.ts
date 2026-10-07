/**
 * Per-user resource limits.
 *
 * Every limit here exists because its absence is not a degradation but an
 * outage: an unbounded command exhausts memory, an unbounded loop exhausts
 * CPU, an unbounded write exhausts the disk, and in each case the victim is
 * every other user plus the operator.
 *
 * All state is per-user, so one person's usage can never consume another's
 * allowance.
 */

export type LimitKind = "concurrent" | "disk" | "rate" | "notebook";

export class LimitError extends Error {
  constructor(
    message: string,
    readonly limit: LimitKind,
  ) {
    super(message);
    this.name = "LimitError";
  }
}

export interface LimitOptions {
  /** Simultaneous long-running actions per user. */
  maxConcurrent?: number;
  /** Total bytes a user's workspace may occupy. */
  maxDiskBytes?: number;
  /** Rows a notebook result may contain. */
  maxNotebookRows?: number;
  /** Cells a single notebook run may contain. */
  maxNotebookCells?: number;
  /** Actions per rolling minute. */
  maxActionsPerMinute?: number;
}

const DEFAULTS: Required<LimitOptions> = {
  // Deliberately small: this is a shared box with one CPU, not a fleet.
  maxConcurrent: 2,
  maxDiskBytes: 100 * 1024 * 1024,
  maxNotebookRows: 10_000,
  maxNotebookCells: 200,
  maxActionsPerMinute: 30,
};

const RATE_WINDOW_MS = 60_000;

/** A slot held by a running action; releasing it is idempotent. */
export interface Slot {
  release(): void;
}

function validate(options: LimitOptions): Required<LimitOptions> {
  const merged = { ...DEFAULTS, ...options };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`limit ${key} must be a positive finite number, got ${value}`);
    }
  }
  return merged;
}

export class UserLimiter {
  private readonly limits: Required<LimitOptions>;
  /** Per-user count of running actions. */
  private readonly inFlightCount = new Map<string, number>();
  /** Per-user bytes recorded as used. */
  private readonly diskUsed = new Map<string, number>();
  /** Per-user timestamps of recent actions. */
  private readonly actionTimes = new Map<string, number[]>();

  constructor(
    options: LimitOptions = {},
    /** Injectable clock, so window expiry is testable without waiting. */
    private readonly now: () => number = () => Date.now(),
  ) {
    this.limits = validate(options);
  }

  // ---- concurrency --------------------------------------------------------

  inFlight(user: string): number {
    return this.inFlightCount.get(user) ?? 0;
  }

  /**
   * Reserve a concurrency slot.
   *
   * The caller must release it; prefer `withSlot`, which cannot leak a slot on
   * a thrown error.
   */
  acquire(user: string): Slot {
    const current = this.inFlight(user);
    if (current >= this.limits.maxConcurrent) {
      throw new LimitError(
        `too many concurrent actions (limit ${this.limits.maxConcurrent}); wait for one to finish`,
        "concurrent",
      );
    }
    this.inFlightCount.set(user, current + 1);

    let released = false;
    return {
      release: () => {
        // Releasing twice must not hand back a slot the caller never held,
        // which would let a user exceed the limit by over-releasing.
        if (released) return;
        released = true;
        const next = Math.max(0, this.inFlight(user) - 1);
        this.inFlightCount.set(user, next);
      },
    };
  }

  /** Run `fn` holding a slot, releasing it whatever happens. */
  async withSlot<T>(user: string, fn: () => Promise<T>): Promise<T> {
    const slot = this.acquire(user);
    try {
      return await fn();
    } finally {
      slot.release();
    }
  }

  // ---- disk ---------------------------------------------------------------

  /** Verify a write of `bytes` (negative for a deletion) fits the quota. */
  checkDisk(user: string, bytes: number): void {
    if (bytes < 0) return; // deletions always allowed, or a user cannot recover
    const used = this.diskUsed.get(user) ?? 0;
    if (used + bytes > this.limits.maxDiskBytes) {
      throw new LimitError(
        `workspace quota exceeded (${this.limits.maxDiskBytes} bytes); ` +
          `delete files to free space`,
        "disk",
      );
    }
  }

  recordUsage(user: string, bytes: number): void {
    this.diskUsed.set(user, Math.max(0, (this.diskUsed.get(user) ?? 0) + bytes));
  }

  remainingDisk(user: string): number {
    return Math.max(0, this.limits.maxDiskBytes - (this.diskUsed.get(user) ?? 0));
  }

  usage(user: string): number {
    return this.diskUsed.get(user) ?? 0;
  }

  // ---- rate ---------------------------------------------------------------

  /** Record an action, throwing if the user has exceeded their rate. */
  checkRate(user: string): void {
    const now = this.now();
    const recent = (this.actionTimes.get(user) ?? []).filter((t) => now - t < RATE_WINDOW_MS);

    if (recent.length >= this.limits.maxActionsPerMinute) {
      // Keep the pruned list so the window can still expire.
      this.actionTimes.set(user, recent);
      throw new LimitError(
        `rate limit exceeded (${this.limits.maxActionsPerMinute} actions/minute); slow down`,
        "rate",
      );
    }

    recent.push(now);
    this.actionTimes.set(user, recent);
  }

  // ---- notebook -----------------------------------------------------------

  checkNotebook(user: string, rows: number, cells: number): void {
    // Non-finite values would slip past a plain `>` comparison, and an
    // unbounded generator is exactly the case this limit exists for.
    if (!Number.isFinite(rows) || rows < 0) {
      throw new LimitError("notebook result row count is not a finite number", "notebook");
    }
    if (!Number.isFinite(cells) || cells < 0) {
      throw new LimitError("notebook cell count is not a finite number", "notebook");
    }
    if (cells > this.limits.maxNotebookCells) {
      throw new LimitError(
        `notebook has too many cells (limit ${this.limits.maxNotebookCells})`,
        "notebook",
      );
    }
    if (rows > this.limits.maxNotebookRows) {
      throw new LimitError(
        `notebook result has too many rows (limit ${this.limits.maxNotebookRows})`,
        "notebook",
      );
    }
  }

  /** The effective configuration, for reporting to clients and operators. */
  describe(): Required<LimitOptions> {
    return { ...this.limits };
  }
}

/** Count rows in a JSON-serialisable notebook value, bounded. */
export function countRows(value: unknown, cap = 1_000_000): number {
  if (Array.isArray(value)) return Math.min(value.length, cap);
  if (value instanceof Map || value instanceof Set) return Math.min(value.size, cap);
  if (value !== null && typeof value === "object") {
    return Math.min(Object.keys(value).length, cap);
  }
  return 1;
}

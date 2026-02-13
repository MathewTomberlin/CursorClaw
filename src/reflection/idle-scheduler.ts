export interface IdleReflectionSchedulerOptions {
  idleAfterMs: number;
  tickMs: number;
  maxConcurrentJobs: number;
}

export interface IdleReflectionJob {
  id: string;
  run: () => Promise<void>;
}

export class IdleReflectionScheduler {
  private lastActivityMs = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private runningJobs = 0;
  private readonly queue: IdleReflectionJob[] = [];

  constructor(private readonly options: IdleReflectionSchedulerOptions) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.tickMs);
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  noteActivity(now = Date.now()): void {
    this.lastActivityMs = now;
    // Cancel queued work immediately to keep user-facing latency prioritized.
    this.queue.length = 0;
  }

  enqueue(job: IdleReflectionJob): void {
    this.queue.push(job);
  }

  hasJob(id: string): boolean {
    return this.queue.some((job) => job.id === id);
  }

  getState(now = Date.now()): {
    idle: boolean;
    queuedJobs: number;
    runningJobs: number;
    idleForMs: number;
  } {
    const idleForMs = now - this.lastActivityMs;
    return {
      idle: idleForMs >= this.options.idleAfterMs,
      queuedJobs: this.queue.length,
      runningJobs: this.runningJobs,
      idleForMs
    };
  }

  private async tick(now = Date.now()): Promise<void> {
    const idleForMs = now - this.lastActivityMs;
    if (idleForMs < this.options.idleAfterMs) {
      return;
    }
    while (
      this.runningJobs < this.options.maxConcurrentJobs &&
      this.queue.length > 0
    ) {
      const job = this.queue.shift();
      if (!job) {
        continue;
      }
      this.runningJobs += 1;
      void job
        .run()
        .catch(() => undefined)
        .finally(() => {
          this.runningJobs -= 1;
        });
    }
  }
}

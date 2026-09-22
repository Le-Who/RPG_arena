type QueueCount = { status: string; n: number };

/** Current snapshot gauges, not a time-windowed failure rate. Naive DB timestamps are UTC. */
export function summarizeQueueHealth(
  groups: QueueCount[][],
  dates: (string | Date | null | undefined)[],
  now = Date.now(),
) {
  const rows = groups.flat();
  const count = (value: number) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  const observedJobs = rows.reduce((total, row) => total + count(row.n), 0);
  const failedJobs = rows.filter(row => row.status === "failed").reduce((total, row) => total + count(row.n), 0);
  const times = dates.filter((value): value is string | Date => value != null).map(value => {
    const normalized = typeof value === "string" && !/(Z|[+-]\d{2}(?::?\d{2})?)$/.test(value)
      ? `${value.replace(" ", "T")}Z` : value;
    return new Date(normalized).getTime();
  }).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : null;
  return {
    observedJobs, failedJobs, failedRatio: observedJobs ? failedJobs / observedJobs : 0,
    oldestPendingAt: oldest === null ? null : new Date(oldest).toISOString(),
    oldestPendingAgeMs: oldest === null ? null : Math.max(0, now - oldest),
  };
}

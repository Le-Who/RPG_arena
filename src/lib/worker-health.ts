import { randomUUID } from "node:crypto";

const processInstance = randomUUID();
const freshForMs = 120_000;

/** One stable ID per process; a stopped process can never overwrite another process's heartbeat. */
export function workerHeartbeatKey(source: "worker" | "manual" | "after", ownerId?: string, instanceId: string = processInstance): string {
  return source === "worker" ? `memory:worker:${instanceId}` : `memory:${source}:${ownerId ?? "none"}`;
}

type WorkerBeat = { id: string; status: string; lastSeenAt: Date };

/** Input is a bounded recent snapshot, not a complete historical worker registry. */
export function summarizeWorkerHealth(beats: WorkerBeat[], now = Date.now()) {
  const instances = [...beats].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()).map(beat => ({
    id: beat.id,
    status: beat.status,
    lastSeenAt: beat.lastSeenAt.toISOString(),
    heartbeatAgeMs: Math.max(0, now - beat.lastSeenAt.getTime()),
    online: beat.status !== "stopped" && now - beat.lastSeenAt.getTime() < freshForMs,
  }));
  const online = instances.filter(instance => instance.online);
  const representative = online.find(instance => instance.status === "running") ?? online[0] ?? instances[0];
  return {
    online: online.length > 0,
    onlineInstances: online.length,
    observedInstances: instances.length,
    heartbeatAgeMs: representative?.heartbeatAgeMs ?? null,
    status: representative?.status ?? "not-started",
    lastSeenAt: representative?.lastSeenAt ?? null,
    report: null,
    instances,
  };
}

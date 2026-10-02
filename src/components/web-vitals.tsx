"use client";
import { useEffect } from "react";
import { useReportWebVitals } from "next/web-vitals";
import { API_RESOURCE_METRICS, MAX_BATCH, TURN_MEASURE_METRICS, VITAL_METRICS, routeTemplate, type SampleMetric } from "@/lib/performance-report";

/** PERF-1 / PERF-2 / PERF-4: anonymous field measurements from production builds.
 * Mount only when the server's opt-in flag is enabled. Sends route templates, never raw paths.
 * Respects Do Not Track / Global Privacy Control; no prose, identifiers or storage keys leave the page. */
type Pending = { metric: SampleMetric; value: number; route: string; device: "mobile" | "desktop"; navigationType: string };
const queue: Pending[] = [];
const reportedResources = new Set<string>();
const reportedVitals = new Set<string>();
let flushTimer: number | undefined;

function allowed(): boolean {
  if (process.env.NODE_ENV !== "production" || typeof navigator === "undefined") return false;
  const privacy = navigator as Navigator & { globalPrivacyControl?: boolean };
  return navigator.doNotTrack !== "1" && privacy.globalPrivacyControl !== true;
}

function flush() {
  if (flushTimer !== undefined) { window.clearTimeout(flushTimer); flushTimer = undefined; }
  while (queue.length) {
    const samples = queue.splice(0, MAX_BATCH);
    try {
      void fetch("/api/telemetry/vitals", { method: "POST", keepalive: true, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ samples }) }).catch(() => undefined);
    } catch { /* telemetry is best-effort and never blocks the story */ }
  }
}

function enqueue(metric: SampleMetric, value: number, navigationType = "", route = routeTemplate(window.location.pathname)) {
  if (!allowed() || !Number.isFinite(value) || value < 0) return;
  queue.push({ metric, value, route, device: window.matchMedia("(max-width:780px)").matches ? "mobile" : "desktop", navigationType });
  if (queue.length >= MAX_BATCH) flush();
  else if (flushTimer === undefined) flushTimer = window.setTimeout(flush, 15_000);
}

// Web Vitals describe a document lifecycle, not whichever SPA route happens to be
// visible when a delayed LCP/INP callback fires. Stable callback prevents replay on renders.
const reportVital: Parameters<typeof useReportWebVitals>[0] = (metric) => {
  if (!allowed() || !(VITAL_METRICS as string[]).includes(metric.name) || reportedVitals.has(metric.id)) return;
  if (reportedVitals.size >= 1000) return;
  reportedVitals.add(metric.id);
  const navigation = performance.getEntriesByType("navigation")[0];
  let route = "other";
  try { route = routeTemplate(new URL(navigation?.name ?? window.location.href).pathname); } catch { /* no raw URL fallback */ }
  enqueue(metric.name as SampleMetric, metric.value, typeof metric.navigationType === "string" ? metric.navigationType : "", route);
};

export function WebVitalsReporter() {
  useReportWebVitals(reportVital);
  useEffect(() => {
    if (!allowed()) return;
    const scanResources = (entries: PerformanceEntry[]) => {
      for (const entry of entries) {
        let url: URL;
        try { url = new URL(entry.name); } catch { continue; }
        const metric = url.origin === window.location.origin ? API_RESOURCE_METRICS[url.pathname] : undefined;
        if (!metric || reportedResources.has(metric)) continue;
        reportedResources.add(metric);
        enqueue(metric, entry.duration);
      }
    };
    let resourceObserver: PerformanceObserver | undefined;
    try {
      resourceObserver = new PerformanceObserver(list => scanResources(list.getEntries()));
      resourceObserver.observe({ type: "resource", buffered: true });
    } catch { scanResources(performance.getEntriesByType("resource")); }
    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) { const metric = TURN_MEASURE_METRICS[entry.name]; if (metric) enqueue(metric, entry.duration); }
      });
      observer.observe({ type: "measure", buffered: true });
    } catch { observer = undefined; }
    const onHidden = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", flush);
    return () => {
      resourceObserver?.disconnect();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  return null;
}

"use client";
import { useEffect, useState } from "react";
import { Download } from "lucide-react";

type InstallChoice = { outcome: "accepted" | "dismissed"; platform: string };
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<InstallChoice> };
declare global { interface Window { __chronicleInstallPrompt?: InstallPromptEvent | null } }

/** ECO-1: production-only registration. public/sw.js never caches /api, HTML documents or cross-origin data. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator) || !window.isSecureContext) return;
    const register = () => { void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined); };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}

/** Shown only when the browser offers installation (captured early by INSTALL_CAPTURE_SCRIPT). */
export function InstallAppButton({ className = "" }: { className?: string }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const sync = () => setAvailable(Boolean(window.__chronicleInstallPrompt));
    const frame = requestAnimationFrame(sync);
    window.addEventListener("chronicle:installable", sync);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("chronicle:installable", sync); };
  }, []);
  if (!available) return null;
  const install = async () => {
    const prompt = window.__chronicleInstallPrompt;
    window.__chronicleInstallPrompt = null;
    setAvailable(false);
    if (!prompt) return;
    try { await prompt.prompt(); await prompt.userChoice; } catch { /* the browser may refuse a stale prompt */ }
  };
  return <button type="button" className={className} onClick={() => void install()}><Download size={18} strokeWidth={1.6} /><span>Установить приложение</span></button>;
}

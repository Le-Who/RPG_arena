"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, LoaderCircle } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import { useApp } from "./app-shell";

export function CampaignCopyButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { refresh, identity } = useApp();
  const request = useRef<string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = async () => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    request.current ??= crypto.randomUUID();
    try {
      const result = await api<{ session: { id: string; ownerId: string } }>(`/api/sessions/${sessionId}/copy`, jsonBody({ requestId: request.current }));
      if (!mounted.current) return;
      if (identity && identity.profileId !== result.session.ownerId) return;
      if (!await refresh(result.session.ownerId)) return;
      if (!mounted.current) return;
      router.push(`/play/${result.session.id}`);
    } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Не удалось создать личную копию"); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  return <div className="campaign-copy"><button className="button secondary" disabled={busy} onClick={() => void copy()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Copy size={15} />}{busy ? "Создаём вашу копию…" : "Продолжить в своей копии"}</button><small>Отдельная история с текущего хода. Для продолжений используются ваши настройки рассказчика.</small>{error && <p className="form-error" role="alert">{error}</p>}</div>;
}

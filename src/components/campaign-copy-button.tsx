"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, LoaderCircle } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import { useApp } from "./app-shell";

export function CampaignCopyButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const { refresh } = useApp();
  const request = useRef<string | null>(null);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = async () => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    request.current ??= crypto.randomUUID();
    try {
      const result = await api<{ session: { id: string } }>(`/api/sessions/${sessionId}/copy`, jsonBody({ requestId: request.current }));
      await refresh();
      router.push(`/play/${result.session.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось создать личную копию"); }
    finally { locked.current = false; setBusy(false); }
  };
  return <div className="campaign-copy"><button className="button secondary" disabled={busy} onClick={() => void copy()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Copy size={15} />}{busy ? "Создаём вашу копию…" : "Продолжить в своей копии"}</button><small>Личный прогресс с текущего хода. Для ИИ нужен ваш API-ключ.</small>{error && <p className="form-error" role="alert">{error}</p>}</div>;
}

"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api-client";
import type { TurnRequestView, TurnResponse, TurnStage } from "@/lib/turn-contract";
import { readTurnStream, TurnStreamError } from "@/lib/turn-stream";
import { normalizeItemIds } from "@/lib/item-bindings";
export type PendingTurn = { itemIds?: string[]; id: string; sessionId: string; action: string; custom: boolean; expectedTurn: number };
export function readPendingTurn(value: string | null, sessionId: string): PendingTurn | null {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const p = parsed as Partial<PendingTurn>;
    if (p.sessionId !== sessionId || typeof p.id !== "string" || !/^[a-zA-Z0-9._:-]{1,80}$/.test(p.id) || typeof p.action !== "string" || !p.action.trim() || p.action.length > 2000 || typeof p.custom !== "boolean" || typeof p.expectedTurn !== "number" || !Number.isSafeInteger(p.expectedTurn) || p.expectedTurn < 1) return null;
    if (p.itemIds !== undefined) p.itemIds = normalizeItemIds(p.itemIds);
    return p as PendingTurn;
  } catch { return null; }
}
export function useTurnRequest(sessionId: string, onCommitted: (result: TurnResponse) => Promise<void>) {
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [sending, setSending] = useState(false);
  const [remoteRunning, setRemoteRunning] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState("");
  const startedRef = useRef<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [stage, setStage] = useState<TurnStage>("context");
  const pendingRef = useRef<PendingTurn | null>(null);
  const sendingRef = useRef(false);
  const activeSend = useRef<{id: string; controller: AbortController} | null>(null);
  const committed = useRef(onCommitted);
  useEffect(() => { committed.current = onCommitted; }, [onCommitted]);
  const handled = useRef<string | null>(null);
  const storageKey = `chronicle:pending:${sessionId}`;
  const remember = useCallback((next: PendingTurn | null) => {
    pendingRef.current = next; setPending(next);
    try { if (next) sessionStorage.setItem(storageKey, JSON.stringify(next)); else sessionStorage.removeItem(storageKey); } catch { /* server-side request ledger remains the source of truth */ }
  }, [storageKey]);
  const finish = useCallback(async (id: string, result: TurnResponse) => {
    if (handled.current === id) return;
    result = { ...result, playerAction: result.playerAction ?? pendingRef.current?.action };
    handled.current = id;
    if (activeSend.current?.id === id) { activeSend.current.controller.abort(); activeSend.current = null; }
    sendingRef.current = false; setSending(false);
    setPreview(""); remember(null); setRemoteRunning(false); setStage("completed"); setError("");
    if (startedRef.current !== null) performance.measure("chronicle:turn:committed", { start: startedRef.current, detail: { requestId: id, server: result.timings } });
    try { await committed.current(result); }
    catch { setError("Ход сохранён, но обновление экрана не удалось. Перезагрузите страницу — действие не нужно повторять."); }
  }, [remember]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      let value: string | null = null; try { value = sessionStorage.getItem(storageKey); } catch {}
      const restored = readPendingTurn(value, sessionId);
      if (restored) { pendingRef.current = restored; setPending(restored); setError("Найден незавершённый запрос. Проверяем, сохранил ли сервер ваш ход."); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessionId, storageKey]);
  useEffect(() => {
    if (!pending) return;
    let alive = true, checking = false;
    const check = async () => {
      if (checking) return; checking = true;
      try {
        const view = await api<TurnRequestView>(`/api/sessions/${sessionId}/requests/${encodeURIComponent(pending.id)}`);
        if (!alive || pendingRef.current?.id !== pending.id) return;
        setStage(view.stage); setRemoteRunning(view.status === "running");
        if (view.status === "completed" && view.result) await finish(pending.id, view.result);
        if (view.status === "failed" && !sendingRef.current) { setPreview(""); setError((old) => old.startsWith("Найден") ? "Предыдущая попытка не завершилась. Можно безопасно повторить тот же запрос." : old); }
      } catch (e) {
        if (alive && e instanceof ApiError && e.status === 404 && !sendingRef.current) { setRemoteRunning(false); setError((old) => old.startsWith("Найден") ? "Сервер ещё не принял это действие. Повтор сохранит тот же requestId." : old); }
      } finally { checking = false; }
    };
    void check(); const timer = setInterval(() => void check(), 1800);
    return () => { alive = false; clearInterval(timer); };
  }, [pending, sessionId, finish]);
  const send = useCallback(async (action: string, custom: boolean, expectedTurn: number, itemIds: string[] = []) => {
    if (sendingRef.current || remoteRunning || !action.trim()) return false;
    const old = pendingRef.current;
    if (old && (old.action !== action.trim() || old.custom !== custom)) { setError("Сначала завершите или отложите сохранённое действие. Это защищает от случайного двойного хода."); return false; }
    const request = old ?? { sessionId, id: crypto.randomUUID(), action: action.trim(), custom, expectedTurn, ...(itemIds.length ? { itemIds } : {}) };
    startedRef.current = performance.now(); setStartedAt(startedRef.current); setPreview("");
    remember(request); handled.current = null; sendingRef.current = true; setSending(true); setError(""); setStage("context");
    const controller = new AbortController(); activeSend.current = { id: request.id, controller };
    try {
      let firstText = false;
      const response = await fetch(`/api/sessions/${sessionId}/act`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(70_000)]), method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" }, body: JSON.stringify({ action: request.action, custom: request.custom, expectedTurn: request.expectedTurn, requestId: request.id, itemIds: request.itemIds }) });
      let result: TurnResponse;
      if (response.headers.get("content-type")?.includes("application/x-ndjson")) result = await readTurnStream(response, event => {
        if (handled.current === request.id || pendingRef.current?.id !== request.id) return;
        if (event.type === "stage") setStage(event.stage);
        if (event.type === "narration") {
          setPreview(event.text);
          if (event.text && !firstText) { firstText = true; performance.measure("chronicle:turn:first-text", { start: startedRef.current!, detail: { requestId: request.id } }); }
        }
      });
      else {
        const data = await response.json();
        if (!response.ok || !data.ok) throw new ApiError(data.message ?? "Не удалось выполнить ход", response.status, data.code ?? "REQUEST_FAILED");
        result = data;
      }
      await finish(request.id, result); return true;
    } catch (e) {
      if (handled.current === request.id || activeSend.current?.id !== request.id) return true;
      setPreview("");
      setError(e instanceof Error ? e.message : "Связь прервалась. Запрос сохранён; повтор не создаст лишний ход.");
      if (["STALE_TURN", "IDEMPOTENCY_CONFLICT", "INVALID_INPUT"].includes(e instanceof TurnStreamError ? e.error.code : e instanceof ApiError ? e.code : "")) remember(null);
      return false;
    } finally { if (activeSend.current?.id === request.id) { activeSend.current = null; sendingRef.current = false; setSending(false); } }
  }, [sessionId, remember, finish, remoteRunning]);
  const retry = useCallback(async () => { const p = pendingRef.current; return p ? send(p.action, p.custom, p.expectedTurn, p.itemIds) : false; }, [send]);
  const dismiss = useCallback(() => { if (sendingRef.current || remoteRunning) return; remember(null); setPreview(""); setError(""); }, [remember, remoteRunning]);
  return { pending, preview, startedAt, busy: sending || remoteRunning, stage, error, send, retry, dismiss };
}

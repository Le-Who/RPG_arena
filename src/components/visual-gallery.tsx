"use client";
import { useCallback, useEffect, useState } from "react";
import { Camera, ImageOff, LoaderCircle, MapPin, RefreshCw, Save, Star, Trash2, UserRound } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";

type Visual = { id: string; kind: "scene" | "portrait" | "location"; subjectKey: string; turnNumber: number; caption: string; provider: string; model: string; seed: number; status: string; error: string | null; width: number; height: number };
type Identity = { id: string; subjectKey: string; subjectName: string; passport: string; seed: number; referenceVisualId: string | null };
type Gallery = { visuals: Visual[]; identities: Identity[]; config: { enabled: boolean; provider: string; model: string; dailyLimit: number; authenticated: boolean } };

/** VIS-1/VIS-2: ручные иллюстрации. Изображение — не канон и не меняет состояние истории. */
export function VisualGallery({ sessionId, isOwner, npcs, currentLocationId, lastTurn }: {
  sessionId: string; isOwner: boolean; npcs: { key: string; name: string }[]; currentLocationId: string | null; lastTurn: number;
}) {
  const [data, setData] = useState<Gallery | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [portraitSubject, setPortraitSubject] = useState("hero");
  const load = useCallback(async () => { try { setData(await api<Gallery>(`/api/sessions/${sessionId}/visuals`)); } catch (e) { setError(e instanceof Error ? e.message : "Не удалось загрузить галерею"); } }, [sessionId]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  const create = async (kind: Visual["kind"], subject?: string) => {
    setBusy(kind); setError("");
    try { await api(`/api/sessions/${sessionId}/visuals`, jsonBody({ kind, subject, turnNumber: kind === "scene" ? lastTurn : undefined })); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось создать иллюстрацию"); }
    finally { setBusy(""); }
  };
  const remove = async (id: string) => { try { await api(`/api/sessions/${sessionId}/visuals/${id}`, { method: "DELETE" }); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Не удалось удалить"); } };
  const patchIdentity = async (subjectKey: string, patch: Record<string, unknown>) => {
    try { await api(`/api/sessions/${sessionId}/visuals/identities`, { method: "PATCH", body: JSON.stringify({ subjectKey, ...patch }) }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить паспорт"); }
  };
  const retry = (id: string) => { setFailed((f) => ({ ...f, [id]: false })); setRetryKey((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 })); };
  const src = (v: Visual) => `/api/sessions/${sessionId}/visuals/${v.id}${retryKey[v.id] ? `?retry=1&n=${retryKey[v.id]}` : ""}`;

  if (!data) return <div className="gx-side-section"><p className="gx-side-hint">{error || "Загрузка галереи…"}</p></div>;
  const reference = (v: Visual) => data.identities.find((i) => i.subjectKey === v.subjectKey)?.referenceVisualId === v.id;
  return <div className="gx-side-section lx-gallery">
    <div className="gx-side-title"><Camera size={13} />Образы истории</div>
    <p className="gx-side-hint">Иллюстрации создаются по вашему запросу и не меняют канон. Описания сцены, людей и мест передаются внешнему провайдеру: {data.config.provider} · {data.config.model}. Лимит — до {data.config.dailyLimit} в сутки.</p>
    {!data.config.enabled && <p className="lx-error">Визуализация отключена администратором.</p>}
    {data.config.enabled && !data.config.authenticated && <p className="lx-error">Для генерации нужен серверный ключ Pollinations. Уже созданные изображения остаются доступны.</p>}
    {isOwner && data.config.enabled && data.config.authenticated && <div className="lx-gallery-actions">
      <button type="button" className="button secondary" disabled={!!busy || lastTurn < 1} onClick={() => void create("scene")}>{busy === "scene" ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />}Сцена хода {lastTurn || "—"}</button>
      <button type="button" className="button secondary" disabled={!!busy || !currentLocationId} onClick={() => void create("location", currentLocationId ?? undefined)}>{busy === "location" ? <LoaderCircle size={14} className="spin" /> : <MapPin size={14} />}Это место</button>
      <div className="lx-row">
        <select aria-label="Чей портрет" value={portraitSubject} onChange={(e) => setPortraitSubject(e.target.value)}><option value="hero">Герой</option>{npcs.map((n) => <option key={n.key} value={`npc:${n.key}`}>{n.name}</option>)}</select>
        <button type="button" className="button secondary" disabled={!!busy} onClick={() => void create("portrait", portraitSubject)}>{busy === "portrait" ? <LoaderCircle size={14} className="spin" /> : <UserRound size={14} />}Портрет</button>
      </div>
    </div>}
    {error && <p className="lx-error" role="alert">{error}</p>}
    <div className="lx-visuals">
      {data.visuals.map((v) => <figure key={v.id} className={`lx-visual is-${v.kind}`}>
        {failed[v.id] || v.status === "failed" || (v.status !== "ready" && (!isOwner || !data.config.authenticated))
          ? <div className="lx-visual-fail"><ImageOff size={22} /><small>{!isOwner && v.status !== "ready" ? "Иллюстрация ещё не готова владельцем" : !data.config.authenticated && v.status !== "ready" ? "Для генерации нужен ключ Pollinations" : v.error ?? "Провайдер не ответил"}</small>{isOwner && data.config.authenticated && <button type="button" className="button secondary" onClick={() => retry(v.id)}><RefreshCw size={13} />Повторить тем же провайдером</button>}</div>
          // eslint-disable-next-line @next/next/no-img-element
          : <img src={src(v)} alt={v.caption} loading="lazy" width={v.width} height={v.height} onError={() => setFailed((f) => ({ ...f, [v.id]: true }))} />}
        <figcaption><span>{v.caption}</span><small>seed {v.seed}{reference(v) ? " · эталон" : ""}</small>
          {isOwner && <span className="lx-row">
            {v.kind !== "scene" && <button type="button" className="lx-icon-btn" aria-label="Сделать эталоном внешности" title="Сделать эталоном" onClick={() => void patchIdentity(v.subjectKey, { referenceVisualId: reference(v) ? null : v.id })}><Star size={13} fill={reference(v) ? "currentColor" : "none"} /></button>}
            <button type="button" className="lx-icon-btn" aria-label="Удалить изображение" onClick={() => void remove(v.id)}><Trash2 size={13} /></button>
          </span>}
        </figcaption>
      </figure>)}
      {!data.visuals.length && <p className="gx-empty-hint">Пока нет иллюстраций.</p>}
    </div>
    {!!data.identities.length && <>
      <div className="gx-side-title"><UserRound size={13} />Паспорта внешности</div>
      <p className="gx-side-hint">Описание и постоянный seed сохраняют узнаваемость персонажа и места между иллюстрациями.</p>
      {data.identities.map((identity) => <IdentityEditor key={identity.id + identity.passport} identity={identity} disabled={!isOwner} onSave={(patch) => void patchIdentity(identity.subjectKey, patch)} />)}
    </>}
  </div>;
}

function IdentityEditor({ identity, disabled, onSave }: { identity: Identity; disabled: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const [passport, setPassport] = useState(identity.passport);
  return <form className="lx-identity" onSubmit={(e) => { e.preventDefault(); onSave({ passport }); }}>
    <label><strong>{identity.subjectName}</strong><small> · seed {identity.seed}{identity.referenceVisualId ? " · эталон выбран" : ""}</small>
      <textarea rows={2} maxLength={600} value={passport} disabled={disabled} onChange={(e) => setPassport(e.target.value)} placeholder="Внешность: возраст, черты, одежда, характерные детали" /></label>
    {!disabled && <div className="lx-row"><button type="submit" className="button secondary" disabled={passport === identity.passport}><Save size={13} />Сохранить</button><button type="button" className="button secondary" onClick={() => onSave({ reseed: true })}><RefreshCw size={13} />Новый облик</button></div>}
  </form>;
}

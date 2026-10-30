"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, ImageOff, LoaderCircle, MapPin, RefreshCw, Save, Star, Trash2, UserRound } from "lucide-react";
import { api, jsonBody } from "@/lib/api-client";
import { OPENAI_VISUAL_ERRORS } from "@/lib/visual-errors";
import { ContextualHelp } from "./contextual-help";

type Visual = { id: string; kind: "scene" | "portrait" | "location"; subjectKey: string; turnNumber: number; caption: string; provider: string; model: string; seed: number; status: string; error: string | null; width: number; height: number };
type Identity = { id: string; subjectKey: string; subjectName: string; passport: string; seed: number; referenceVisualId: string | null };
type Gallery = { visuals: (Visual & { accountSource?: "application" | "personal"; generationBlocked?: boolean })[]; identities: Identity[]; config: { enabled: boolean; provider: string; accountSource?: "application" | "personal"; availableAccounts?: { application: boolean; personal: boolean }; model: string; dailyLimit: number; authenticated: boolean } };

const serviceName = (provider: string) => provider === "openrouter" ? "OpenRouter" : provider === "pollinations" ? "Pollinations" : provider === "openai" ? "OpenAI" : provider;

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
  const [styleDraft, setStyleDraft] = useState({ sessionId, value: "" });
  const styleOverride = styleDraft.sessionId === sessionId ? styleDraft.value : "";
  const loadRequest = useRef(0);
  const cancelLoad = useCallback(() => { loadRequest.current++; }, []);
  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    setError("");
    try { const result = await api<Gallery>(`/api/sessions/${sessionId}/visuals`); if (request === loadRequest.current) setData(result); }
    catch (e) { if (request === loadRequest.current) setError(e instanceof Error ? e.message : "Не удалось загрузить галерею"); }
  }, [sessionId]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => { window.clearTimeout(timer); cancelLoad(); }; }, [load, cancelLoad]);
  const create = async (kind: Visual["kind"], subject?: string) => {
    const requestedStyle = styleOverride.trim();
    setBusy(kind); setError("");
    try { await api(`/api/sessions/${sessionId}/visuals`, jsonBody({ kind, subject, turnNumber: kind === "scene" ? lastTurn : undefined, ...(requestedStyle ? { styleOverride: requestedStyle } : {}) })); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось создать иллюстрацию"); }
    finally { setBusy(""); }
  };
  const remove = async (id: string) => { try { await api(`/api/sessions/${sessionId}/visuals/${id}`, { method: "DELETE" }); await load(); } catch (e) { setError(e instanceof Error ? e.message : "Не удалось удалить"); } };
  const patchIdentity = async (subjectKey: string, patch: Record<string, unknown>) => {
    try { await api(`/api/sessions/${sessionId}/visuals/identities`, { method: "PATCH", body: JSON.stringify({ subjectKey, ...patch }) }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить описание внешности"); }
  };
  const retry = (id: string) => { setFailed((f) => ({ ...f, [id]: false })); setRetryKey((r) => ({ ...r, [id]: (r[id] ?? 0) + 1 })); };
  const src = (v: Visual) => `/api/sessions/${sessionId}/visuals/${v.id}${retryKey[v.id] ? `?retry=1&n=${retryKey[v.id]}` : ""}`;
  const canRender = (v: Gallery["visuals"][number]) => !v.generationBlocked && data?.config.enabled && (data.config.availableAccounts?.[v.accountSource ?? "application"] ?? data.config.authenticated);

  if (!data) return <div className="gx-side-section">{error ? <div className="notice error-notice" role="alert"><p>{error}</p><button type="button" className="button secondary" onClick={() => void load()}>Повторить загрузку галереи</button></div> : <p className="gx-side-hint" role="status">Загрузка галереи…</p>}</div>;
  const reference = (v: Visual) => data.identities.find((i) => i.subjectKey === v.subjectKey)?.referenceVisualId === v.id;
  return <div className="gx-side-section lx-gallery">
    <div className="gx-side-title"><Camera size={13} />Образы истории<ContextualHelp title="Образы истории"><p>Иллюстрации помогают представить сцену, персонажа или место. Они не меняют события и состояние истории.</p><p>У готового изображения сохраняются сервис, модель и источник оплаты. Повторное создание использует эти настройки, даже если для новых изображений вы выбрали другие.</p><p>Описание внешности и выбранный эталон помогают сохранить узнаваемость. «Новый облик» меняет вариант для следующих иллюстраций; готовые изображения сохраняются.</p></ContextualHelp></div>
    <p className="gx-side-hint">Для создания иллюстраций описания сцен, людей и мест передаются в {serviceName(data.config.provider)}. До {data.config.dailyLimit} изображений в сутки.</p>
    {isOwner && <p className="gx-side-hint">Оплата новых изображений: <strong>{data.config.accountSource === "personal" ? `ваш аккаунт ${serviceName(data.config.provider)}, расходуется ваш ${data.config.provider === "pollinations" ? "Pollen" : "баланс"}` : `аккаунт приложения ${serviceName(data.config.provider)}`}</strong>. Модель: {data.config.model}. <Link href="/settings#visual-provider">Настроить иллюстрации</Link></p>}
    {!data.config.enabled && <p className="gx-side-hint" role="status">Создание иллюстраций выключено. Уже созданные изображения остаются доступны.</p>}
    {data.config.enabled && !data.config.authenticated && <p className="notice amber" role="alert">Выбранный аккаунт {serviceName(data.config.provider)} недоступен. {isOwner && "Проверьте подключение в настройках иллюстраций. "}Уже созданные изображения остаются доступны.</p>}
    {isOwner && data.config.enabled && data.config.authenticated && <div className="lx-gallery-actions">
      <button type="button" className="button secondary" disabled={!!busy || lastTurn < 1} onClick={() => void create("scene")}>{busy === "scene" ? <LoaderCircle size={14} className="spin" /> : <Camera size={14} />}Сцена хода {lastTurn || "—"}</button>
      <button type="button" className="button secondary" disabled={!!busy || !currentLocationId} onClick={() => void create("location", currentLocationId ?? undefined)}>{busy === "location" ? <LoaderCircle size={14} className="spin" /> : <MapPin size={14} />}Это место</button>
      <div className="lx-row">
        <select aria-label="Чей портрет" value={portraitSubject} onChange={(e) => setPortraitSubject(e.target.value)}><option value="hero">Герой</option>{npcs.map((n) => <option key={n.key} value={`npc:${n.key}`}>{n.name}</option>)}</select>
        <button type="button" className="button secondary" disabled={!!busy} onClick={() => void create("portrait", portraitSubject)}>{busy === "portrait" ? <LoaderCircle size={14} className="spin" /> : <UserRound size={14} />}Портрет</button>
      </div>
      <details><summary>Стиль иллюстраций</summary><div className="lx-identity">
        <p className="gx-side-hint">По тону и сеттингу истории</p>
        <label><span>Свой стиль</span><textarea rows={3} maxLength={400} value={styleOverride} onChange={event => setStyleDraft({ sessionId, value: event.target.value })} placeholder="Ироничная акварель, мягкие цвета" /></label>
        <p className="gx-side-hint">Пустое поле — стиль по истории. Свой стиль действует на новые иллюстрации. Повторное создание сохраняет исходное описание.</p>
      </div></details>
    </div>}
    {error && <p className="lx-error" role="alert">{error}</p>}
    <div className="lx-visuals">
      {data.visuals.map((v) => <figure key={v.id} className={`lx-visual is-${v.kind}`}>
        {failed[v.id] || (v.status === "failed" && !retryKey[v.id]) || (v.status !== "ready" && (!isOwner || !canRender(v)))
          ? <div className="lx-visual-fail"><ImageOff size={22} /><small>{!isOwner && v.status !== "ready" ? "Владелец ещё не создал иллюстрацию" : !canRender(v) && v.status !== "ready" ? "Создание иллюстраций пока недоступно" : v.error ? Object.hasOwn(OPENAI_VISUAL_ERRORS, v.error) ? OPENAI_VISUAL_ERRORS[v.error] : v.error : "Сервис иллюстраций не ответил"}</small>{isOwner && canRender(v) && <button type="button" className="button secondary" onClick={() => retry(v.id)}><RefreshCw size={13} />Повторить создание</button>}</div>
          // eslint-disable-next-line @next/next/no-img-element
          : <img src={src(v)} alt={v.caption} loading="lazy" width={v.width} height={v.height} onError={() => setFailed((f) => ({ ...f, [v.id]: true }))} />}
        <figcaption><span>{v.caption}</span><small>{v.accountSource === "personal" ? "Личный аккаунт" : "Аккаунт приложения"} {serviceName(v.provider)} · {v.model}</small>{reference(v) && <small>Эталон внешности</small>}
          {isOwner && <span className="lx-row">
            {v.kind !== "scene" && <button type="button" className="lx-icon-btn" aria-label="Сделать эталоном внешности" title="Сделать эталоном" onClick={() => void patchIdentity(v.subjectKey, { referenceVisualId: reference(v) ? null : v.id })}><Star size={13} fill={reference(v) ? "currentColor" : "none"} /></button>}
            <button type="button" className="lx-icon-btn" aria-label="Удалить изображение" onClick={() => void remove(v.id)}><Trash2 size={13} /></button>
          </span>}
        </figcaption>
      </figure>)}
      {!data.visuals.length && <p className="gx-empty-hint">Пока нет иллюстраций.</p>}
    </div>
    {!!data.identities.length && <>
      <div className="gx-side-title"><UserRound size={13} />Описание внешности</div>
      {data.identities.map((identity) => <IdentityEditor key={identity.id + identity.passport} identity={identity} disabled={!isOwner} onSave={(patch) => void patchIdentity(identity.subjectKey, patch)} />)}
    </>}
  </div>;
}

function IdentityEditor({ identity, disabled, onSave }: { identity: Identity; disabled: boolean; onSave: (patch: Record<string, unknown>) => void }) {
  const [passport, setPassport] = useState(identity.passport);
  return <form className="lx-identity" onSubmit={(e) => { e.preventDefault(); onSave({ passport }); }}>
    <label><strong>{identity.subjectName}</strong>{identity.referenceVisualId && <small> · эталон выбран</small>}
      <textarea rows={2} maxLength={600} value={passport} disabled={disabled} onChange={(e) => setPassport(e.target.value)} placeholder="Внешность: возраст, черты, одежда, характерные детали" /></label>
    {!disabled && <div className="lx-row"><button type="submit" className="button secondary" disabled={passport === identity.passport}><Save size={13} />Сохранить</button><button type="button" className="button secondary" onClick={() => onSave({ reseed: true })}><RefreshCw size={13} />Новый облик</button></div>}
  </form>;
}

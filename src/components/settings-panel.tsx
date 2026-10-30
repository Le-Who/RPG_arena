"use client";
import { useFeedbackState } from "./feedback";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AccountSettings } from "./account-settings";
import { DeveloperSettings } from "./developer-settings";
import { NarrativeSettings } from "./narrative-settings";
import { TextProviderSettings } from "./text-provider-settings";
import { ImageProviderSettings } from "./image-provider-settings";
import { ServiceConnections } from "./service-connections";
import { ContextualHelp } from "./contextual-help";
import { PollinationsConnectionNotice } from "./pollinations-connect";
import { UnsavedChangesDialog } from "./unsaved-changes-dialog";
import { useDirtyHistory } from "./use-dirty-history";
import { ArrowRight, BookOpenText, BrainCircuit, Database, LoaderCircle, LockKeyhole, Save, ShieldCheck, Sparkles, UserRound, Wifi } from "lucide-react";
import { useApp } from "./app-shell";
import { api, jsonBody } from "@/lib/api-client";
import type { Settings } from "@/lib/ui-data";
import { READING_OPTIONS } from "@/lib/reading-preferences";
import type { ReadingPreferences } from "@/db/schema";
type Usage = { today: { totalReq: number; totalTokens: number; errors: number; embeddingReq: number }; quotas: { note: string } };
export type SettingsPanelProps = { onClose?: () => void; returnLabel?: string; onCloseReady?: (close: (() => void) | null, label?: string) => void };
export function SettingsPanel(props: SettingsPanelProps) {
  const { settings, loading, refresh, administration } = useApp();
  const [developer, setDeveloper] = useState(false);
  const { onCloseReady } = props;
  const registerDeveloperClose = useCallback((close: (() => void) | null) => onCloseReady?.(close, "Назад к настройкам"), [onCloseReady]);
  if (!settings) return <div className="play-loading"><LoaderCircle className="spin" size={27} /><h2>Загружаем настройки…</h2>{!loading && <button className="button secondary" onClick={() => void refresh()}>Попробовать снова</button>}</div>;
  if (developer && administration) return <DeveloperSettings onClose={() => setDeveloper(false)} returnLabel="Назад к настройкам" onCloseReady={registerDeveloperClose} />;
  return <><PollinationsConnectionNotice /><SettingsForm {...props} onDeveloper={() => setDeveloper(true)} /></>;
}
function SettingsForm({ onClose, returnLabel = "Вернуться", onCloseReady, onDeveloper }: SettingsPanelProps & { onDeveloper: () => void }) {
  const router = useRouter();
  const { settings, workspace, refresh, acceptSettings, notify, resolveNotification, updateReading, identity, administration } = useApp();
  const [draft, setDraft] = useState<Settings>(settings!);
  const [baseline, setBaseline] = useState(JSON.stringify(settings));
  const [confirmClose, setConfirmClose] = useState(false);
  const closeAction = useRef(onClose);
  const [name, setName] = useState(workspace.displayName);
  const [batchSaving, setSaving] = useState(false);
  const [connectionsSaving, setConnectionsSaving] = useState(false);
  const [narratorSaving, setNarratorSaving] = useState(false);
  const [canonicalPending, setCanonicalPending] = useState(false);
  const [canonicalLoading, setCanonicalLoading] = useState(false);
  const [canonicalError, setCanonicalError] = useState(false);
  const canonicalPendingRef = useRef(false);
  const saving = batchSaving || connectionsSaving || narratorSaving || canonicalPending;
  const draftRevision = useRef(0);
  const markNestedDraftChange = useCallback(() => { draftRevision.current++; }, []);
  const savingAll = useRef(false);
  const providerSavedDuringBatch = useRef(false);
  const canonicalRequest = useRef(0);
  const [narrativeDirty, setNarrativeDirty] = useState(false);
  const [textProviderDirty, setTextProviderDirty] = useState(false);
  const [imageProviderDirty, setImageProviderDirty] = useState(false);
  const [advancedKeyRevision, setAdvancedKeyRevision] = useState(0);
  const [connectionsDirty, setConnectionsDirty] = useState(false);
  const [imageExpanded, setImageExpanded] = useState(false);
  const connectionsSave = useRef<(() => Promise<boolean>) | null>(null);
  const onConnectionsSaveReady = useCallback((save: (() => Promise<boolean>) | null) => { connectionsSave.current = save; }, []);
  const [pollinationsRevision, setPollinationsRevision] = useState(0);
  const imageProviderSave = useRef<(() => Promise<boolean>) | null>(null);
  const onImageProviderSaveReady = useCallback((save: (() => Promise<boolean>) | null) => { imageProviderSave.current = save; }, []);
  const textProviderSave = useRef<(() => Promise<boolean>) | null>(null);
  const onTextProviderSaveReady = useCallback((save: (() => Promise<boolean>) | null) => { textProviderSave.current = save; }, []);
  const clearCanonicalPending = useCallback(() => {
    canonicalPendingRef.current = false;
    setCanonicalPending(false); setCanonicalLoading(false); setCanonicalError(false);
  }, []);
  const reloadCanonical = useCallback(async () => {
    const request = ++canonicalRequest.current;
    const profileId = identity?.profileId;
    canonicalPendingRef.current = true;
    setCanonicalPending(true); setCanonicalLoading(true); setCanonicalError(false);
    try {
      const saved = await api<Settings>("/api/settings");
      if (request !== canonicalRequest.current) return null;
      setDraft(old => ({ ...old, keysCount: saved.keysCount, keysMasked: saved.keysMasked, envKeysCount: saved.envKeysCount, credentialIssues: saved.credentialIssues, canUseLive: saved.canUseLive }));
      setBaseline(old => JSON.stringify({ ...JSON.parse(old), keysCount: saved.keysCount, keysMasked: saved.keysMasked, envKeysCount: saved.envKeysCount, credentialIssues: saved.credentialIssues, canUseLive: saved.canUseLive }));
      acceptSettings(saved, profileId); resolveNotification("settings-canonical");
      clearCanonicalPending();
      return saved;
    } catch {
      if (request !== canonicalRequest.current) return null;
      // The mutation may already have removed a credential. Never expose its old readiness.
      if (settings) acceptSettings({ ...settings, canUseLive: false }, profileId);
      setDraft(old => ({ ...old, canUseLive: false }));
      setBaseline(old => JSON.stringify({ ...JSON.parse(old), canUseLive: false }));
      setCanonicalError(true);
      return null;
    } finally { if (request === canonicalRequest.current) setCanonicalLoading(false); }
  }, [acceptSettings, clearCanonicalPending, identity?.profileId, resolveNotification, settings]);
  const onTextProviderSaved = useCallback(async (useLiveAI: boolean, pollinationsChanged = false) => {
    if (pollinationsChanged) setPollinationsRevision(value => value + 1);
    setDraft(old => ({ ...old, useLiveAI }));
    setBaseline(old => JSON.stringify({ ...JSON.parse(old), useLiveAI }));
    if (savingAll.current) { providerSavedDuringBatch.current = true; return; }
    await reloadCanonical();
  }, [reloadCanonical]);
  const onConnectionsSaved = useCallback(async () => {
    setPollinationsRevision(value => value + 1);
    if (savingAll.current) { providerSavedDuringBatch.current = true; return; }
    await reloadCanonical();
  }, [reloadCanonical]);
  const narrativeSave = useRef<(() => Promise<boolean>) | null>(null);
  const onNarrativeSaveReady = useCallback((save: (() => Promise<boolean>) | null) => { narrativeSave.current = save; }, []);
  const [testing, setTesting] = useState(false);
  const [connection, setConnection] = useFeedbackState<{ ok: boolean; message: string } | null>(null, value => value?.ok === true);
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => { api<Usage>("/api/tokens/stats").then(setUsage).catch(() => {}); }, []);
  function change<K extends keyof Settings>(key: K, value: Settings[K]) { draftRevision.current++; setDraft((old) => ({ ...old, [key]: value })); }
  const save = async () => {
    if (!draft || savingAll.current || canonicalPendingRef.current) return false; setSaving(true); savingAll.current = true;
    providerSavedDuringBatch.current = false;
    canonicalRequest.current++;
    const profileId = identity?.profileId;
    const submittedRevision = draftRevision.current;
    try {
      if (connectionsSave.current && !await connectionsSave.current()) return false;
      if (narrativeSave.current && !await narrativeSave.current()) return false;
      let saved: Settings | undefined;
      if (JSON.stringify(draft) !== baseline) {
        const { useLiveAI: _liveOwnedByNarrator, ...generalDraft } = draft;
        const result = await api<Settings & { ok?: boolean }>("/api/settings", jsonBody({ ...generalDraft, embeddingModel: "gemini-embedding-2" }));
        delete result.ok;
        saved = result;
      }
      if (textProviderSave.current && !await textProviderSave.current()) return false;
      if (imageProviderSave.current && !await imageProviderSave.current()) return false;
      // Narrator settings share useLiveAI with the main form. Read their final
      // projection once after a narrator write, without reloading campaigns/auth.
      if (providerSavedDuringBatch.current) {
        providerSavedDuringBatch.current = false;
        const canonical = await reloadCanonical();
        if (!canonical) return false;
        saved = canonical;
      }
      // Editable controls can change while the request is in flight. Accept canonical
      // values only for fields that still match the submitted snapshot.
      if (saved) {
        const canonical = saved;
        setDraft(current => Object.fromEntries(Object.entries(canonical).map(([key, value]) => [
          key, JSON.stringify(current[key as keyof Settings]) !== JSON.stringify(draft[key as keyof Settings]) ? current[key as keyof Settings] : value,
        ])) as Settings);
        setBaseline(JSON.stringify(canonical));
        acceptSettings(canonical, profileId);
        resolveNotification("gemini-profile"); resolveNotification("settings-canonical");
      }
      providerSavedDuringBatch.current = false;
      if (draftRevision.current !== submittedRevision) { notify("Сохранён отправленный вариант. Новые изменения ещё не сохранены.", "warning", "settings-save"); return false; }
      notify("Настройки сохранены.", false, "settings-save"); return true;
    } catch (e) { notify(e instanceof Error ? e.message : "Не удалось сохранить настройки", true, "settings-save"); return false; } finally { savingAll.current = false; if (providerSavedDuringBatch.current) { providerSavedDuringBatch.current = false; await onConnectionsSaved(); } setSaving(false); }
  };
  const geminiFields = ["routingProfile", "narrationModel", "customActionModel", "compactionModel", "fastTaskModel"] as const;
  const geminiProfileDirty = geminiFields.some(key => draft[key] !== JSON.parse(baseline)[key]);
  const saveGeminiProfile = async () => {
    if (savingAll.current) return true;
    const submittedRevision = draftRevision.current;
    const submitted = Object.fromEntries(geminiFields.map(key => [key, draft[key]]));
    const request = ++canonicalRequest.current;
    const profileId = identity?.profileId;
    try {
      const saved = await api<Settings>("/api/settings", jsonBody(submitted));
      if (request !== canonicalRequest.current) return false;
      setDraft(current => ({ ...current, ...Object.fromEntries(geminiFields.map(key => [key, current[key] === draft[key] ? saved[key] : current[key]])) }));
      setBaseline(old => JSON.stringify({ ...JSON.parse(old), ...Object.fromEntries(geminiFields.map(key => [key, saved[key]])) }));
      acceptSettings(saved, profileId); clearCanonicalPending(); resolveNotification("gemini-profile");
      return submittedRevision === draftRevision.current;
    } catch (cause) { notify(cause instanceof Error ? cause.message : "Не удалось сохранить профиль Gemini.", true, "gemini-profile"); return false; }
  };
  const changeGeminiProfile = (profile: string) => {
    draftRevision.current++;
    const lite = "gemini-3.5-flash-lite", flash = "gemini-3.8-flash";
    setDraft(old => ({ ...old, routingProfile: profile, narrationModel: profile === "flagship" ? flash : lite, customActionModel: profile === "economy" ? lite : flash, compactionModel: flash, fastTaskModel: lite }));
  };
  const cancelGeminiProfile = () => { const saved = JSON.parse(baseline) as Settings; setDraft(old => ({ ...old, ...Object.fromEntries(geminiFields.map(key => [key, saved[key]])) })); };
  const test = async () => {
    setTesting(true); setConnection(null);
    try { const result = await api<{ model: string; dims: number; latencyMs: number }>("/api/settings/test", jsonBody({})); setConnection({ ok: true, message: `Подключение работает · ${result.latencyMs} мс` }); }
    catch (e) { setConnection({ ok: false, message: e instanceof Error ? e.message : "Подключение не удалось" }); } finally { setTesting(false); }
  };
  const removeKey = async (index: number) => { canonicalRequest.current++; const profileId = identity?.profileId; try { const result = await api<Settings & { ok?: boolean }>("/api/settings", jsonBody({ removeIndex: [index] })); delete result.ok; const saved = result; canonicalRequest.current++; setDraft(old => ({ ...old, keysCount: saved.keysCount, keysMasked: saved.keysMasked, envKeysCount: saved.envKeysCount, credentialIssues: saved.credentialIssues, canUseLive: saved.canUseLive, useLiveAI: old.useLiveAI !== JSON.parse(baseline).useLiveAI ? old.useLiveAI : saved.useLiveAI })); setBaseline(old => JSON.stringify({ ...JSON.parse(old), keysCount: saved.keysCount, keysMasked: saved.keysMasked, envKeysCount: saved.envKeysCount, credentialIssues: saved.credentialIssues, canUseLive: saved.canUseLive, useLiveAI: saved.useLiveAI })); acceptSettings(saved, profileId); clearCanonicalPending(); setAdvancedKeyRevision(value => value + 1); setPollinationsRevision(value => value + 1); notify("Ключ удалён", false, "gemini-key"); } catch (e) { notify(e instanceof Error ? e.message : "Ошибка", true, "gemini-key"); if (canonicalPendingRef.current) await reloadCanonical(); } };
  const saveProfile = async () => { setSaving(true); try { await api("/api/workspace", { method: "PATCH", body: JSON.stringify({ displayName: name }) }); await refresh(); notify("Имя профиля сохранено", false, "profile-name"); } catch (e) { notify(e instanceof Error ? e.message : "Ошибка", true, "profile-name"); } finally { setSaving(false); } };
  const dirty = JSON.stringify(draft) !== baseline || name !== workspace.displayName || narrativeDirty || textProviderDirty || imageProviderDirty || connectionsDirty;
  useEffect(() => { if (!dirty && !saving) resolveNotification("settings-connect-guard"); }, [dirty, saving, resolveNotification]);
  // Keep a single history guard through credential write + canonical refresh.
  // Releasing/recreating it between those phases can strand a pending history.back().
  const releaseHistory = useDirtyHistory(dirty || saving, leave => { if (!saving) { closeAction.current = leave; setConfirmClose(true); } }, onClose);
  const requestClose = useCallback(() => { if (saving) return; closeAction.current = () => releaseHistory(onClose); if (dirty) setConfirmClose(true); else releaseHistory(onClose); }, [dirty, saving, onClose, releaseHistory]);
  const openDeveloper = () => { if (saving) return; closeAction.current = () => releaseHistory(onDeveloper); if (dirty) setConfirmClose(true); else releaseHistory(onDeveloper); };
  useEffect(() => { onCloseReady?.(requestClose); return () => onCloseReady?.(null); }, [onCloseReady, requestClose]);
  useEffect(() => { if (!dirty) return; const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, [dirty]);
  useEffect(() => {
    if ((!dirty && !saving) || onClose) return;
    const guard = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      event.preventDefault(); event.stopPropagation();
      if (saving) return;
      closeAction.current = () => releaseHistory(() => router.push(url.pathname + url.search + url.hash));
      setConfirmClose(true);
    };
    document.addEventListener("click", guard, true);
    return () => document.removeEventListener("click", guard, true);
  }, [dirty, saving, onClose, releaseHistory, router]);
  const saveBeforeLeave = async () => {
    if (await save()) {
      if (name !== workspace.displayName) {
        try { await api("/api/workspace", { method: "PATCH", body: JSON.stringify({ displayName: name }) }); await refresh(); resolveNotification("profile-name"); }
        catch { notify("Не удалось сохранить имя профиля", true, "profile-name"); return false; }
      }
      return true;
    }
    return false;
  };
  const totalKeys = draft.keysCount + draft.envKeysCount;
  return <div className="settings-page">{identity?.kind !== "account" && <div className="notice"><ShieldCheck size={18} /><p>Вы играете как гость. Не очищайте данные браузера, чтобы сохранить доступ к историям. Аккаунт позволит продолжить с другого устройства.</p></div>}{onClose && <div className="settings-return"><button className="button secondary" onClick={requestClose} disabled={saving}>{returnLabel}</button></div>}{confirmClose && <UnsavedChangesDialog saving={saving} onSave={saveBeforeLeave} onLeave={() => closeAction.current?.()} onDiscard={() => closeAction.current?.()} onCancel={() => setConfirmClose(false)} />}<div className="page-heading"><div><div className="eyebrow">ДВИЖОК ВАШЕГО ВООБРАЖЕНИЯ</div><h1>Настройки пространства</h1><p>Выберите ИИ и настройте чтение под себя.</p></div><button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}<span>Сохранить настройки</span></button></div>{canonicalPending && <div className="notice amber" role={canonicalError ? "alert" : "status"}><div><p>{canonicalError ? "Изменения записаны, но актуальное состояние подключения не получено. Повторите загрузку перед выходом. Ключи повторно отправляться не будут." : "Обновляем состояние подключения…"}</p>{canonicalError && <button type="button" className="button secondary" disabled={canonicalLoading} onClick={() => void reloadCanonical()}>Повторить загрузку настроек</button>}</div></div>}<div className="settings-layout"><div className="settings-main"><fieldset className="ai-services" aria-labelledby="ai-services-heading" disabled={saving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><div className="ai-services-heading"><div><h2 id="ai-services-heading">ИИ для ваших историй</h2><p>Рассказчик и иллюстрации настраиваются независимо.</p></div><ContextualHelp title="Выбор ИИ"><p>Выберите сервис отдельно для рассказчика и иллюстраций. Один подключённый ключ OpenRouter или Pollinations можно использовать для обеих задач.</p><p>Изменение одной задачи не меняет другую. Новый выбор действует после сохранения. Картинки можно отключить и включить позднее.</p><p>Цена зависит от модели и объёма запроса. Подробности расчёта доступны по значку справки рядом со списком моделей.</p></ContextualHelp></div><div className="ai-task-grid"><TextProviderSettings onSavingChange={setNarratorSaving} onDraftChange={markNestedDraftChange} onDirtyChange={setTextProviderDirty} onSaveReady={onTextProviderSaveReady} onSaved={onTextProviderSaved} connectionRevision={pollinationsRevision} onBeforeSave={async () => { if (canonicalPendingRef.current) return false; if (savingAll.current || !connectionsSave.current) return true; return await connectionsSave.current() && !canonicalPendingRef.current; }} geminiConfigured={totalKeys > 0 && !draft.credentialIssues?.includes("gemini")} geminiModels={draft} onGeminiModelChange={(key, value) => { change(key, value); change("routingProfile", "custom"); }} geminiProfile={draft.routingProfile} geminiModel={draft.narrationModel} onGeminiProfileChange={changeGeminiProfile} geminiProfileDirty={geminiProfileDirty} onSaveGeminiProfile={saveGeminiProfile} onCancelGeminiProfile={cancelGeminiProfile} /><ImageProviderSettings onDraftChange={markNestedDraftChange} onDirtyChange={setImageProviderDirty} onSaveReady={onImageProviderSaveReady} connectionRevision={pollinationsRevision} expanded={imageExpanded} onEdit={() => setImageExpanded(value => !value)} /></div><ServiceConnections onSavingChange={setConnectionsSaving} onDraftChange={markNestedDraftChange} onDirtyChange={setConnectionsDirty} onSaveReady={onConnectionsSaveReady} onSaved={onConnectionsSaved} beforeConnect={async () => { if (dirty || saving) { notify("Перед входом сохраните или отмените изменения настроек. Подключение не применяет их автоматически.", "warning", "settings-connect-guard"); return false; } return true; }} advancedKeyRevision={advancedKeyRevision} geminiKeys={draft.keysMasked} onRemoveGeminiKey={removeKey} /></fieldset><details className="settings-advanced"><summary>Дополнительные настройки ИИ</summary><section className="settings-card"><div className="settings-card-heading"><span className="feature-icon teal"><BrainCircuit size={20} /></span><div><h2>Память, которая держит нить</h2><p>Сохраняем факты и находим нужные воспоминания по смыслу.</p></div></div><SettingToggle title="Поиск воспоминаний по смыслу" description="Находить подходящие воспоминания перед новым ходом." value={draft.embeddingsEnabled} onChange={(value) => change("embeddingsEnabled", value)} /><div className="field-pair embedding-fields"><label className="field"><span>Модель эмбеддингов</span><input value="gemini-embedding-2" readOnly /></label><label className="field"><span>Размерность вектора</span><select value={draft.embeddingDims} onChange={(e) => change("embeddingDims", Number(e.target.value))}><option value={768}>768 · рекомендуем</option><option value={1536}>1536 · больше деталей</option><option value={3072}>3072 · полная размерность</option></select></label></div><div className="setting-explainer"><ShieldCheck size={13} /><span>Поиск изолирован внутри кампании. Векторы разных моделей не смешиваются.</span></div><div className="settings-divider" /><SettingToggle title="Извлечение фактов" description="ИИ выделяет факты из ответа рассказчика. Сервер проверяет цитату-источник." value={draft.semanticExtractionEnabled} onChange={(value) => change("semanticExtractionEnabled", value)} /><div className="connection-test"><button className="button secondary" disabled={testing || !totalKeys} onClick={() => void test()}>{testing ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}{testing ? "Проверяем…" : "Проверить подключение памяти"}</button><span>Запрос к Gemini расходует квоту</span></div>{connection && <p className="notice" role={connection.ok ? "status" : "alert"}>{connection.message}</p>}<p className="settings-footnote">После изменения размерности нажмите «Подготовить поиск» на странице «Память мира». До этого старые векторы не участвуют в поиске.</p></section>
</details>
      <AccountSettings unsaved={dirty || saving} /><section className="settings-card" id="reading"><div className="settings-card-heading"><span className="feature-icon teal"><BookOpenText size={20} /></span><div><h2>Комфорт чтения</h2><p>Изменения применяются и сохраняются сразу.</p></div></div><div className="reading-groups">{([
        { key: "textScale", title: "Размер прозы" },
        { key: "measure", title: "Ширина строки" },
        { key: "theme", title: "Палитра" },
        { key: "motion", title: "Анимации" },
      ] as { key: keyof ReadingPreferences; title: string }[]).map((group) => <div className="reading-group" key={group.key}><span>{group.title}</span><div className="reading-choices">{READING_OPTIONS[group.key].map((option) => <button type="button" key={option.value} className={`reading-choice ${workspace.reading[group.key] === option.value ? "selected" : ""}`} aria-pressed={workspace.reading[group.key] === option.value} onClick={() => void updateReading({ ...workspace.reading, [group.key]: option.value })}><strong>{option.label}</strong><small>{option.hint}</small></button>)}</div></div>)}</div><div className="reading-preview"><small>Предпросмотр</small><p>Туман стелется над причалом, и где-то в тишине бьёт колокол. Вы делаете шаг вперёд — история запоминает каждое ваше решение.</p></div></section>
      <details className="settings-advanced"><summary>Дополнительная проверка повествования</summary><NarrativeSettings onDraftChange={markNestedDraftChange} onDirtyChange={setNarrativeDirty} onSaveReady={onNarrativeSaveReady} /></details>
      <section className="settings-card" id="profile"><div className="settings-card-heading"><span className="feature-icon violet"><UserRound size={20} /></span><div><h2>Как к вам обращаться?</h2><p>Небольшая деталь, которая делает пространство вашим.</p></div></div><div className="profile-edit"><span className="avatar">{name[0] || "И"}</span><label className="field"><input value={name} onChange={(e) => { draftRevision.current++; setName(e.target.value); }} maxLength={40} aria-label="Имя профиля" /></label><button className="button secondary" disabled={saving || !name.trim()} onClick={() => void saveProfile()}>Сохранить</button></div></section>
    </div><aside className="settings-aside"><div className="settings-card usage-card"><div className="side-section-title no-top-margin"><Database size={14} />СЕГОДНЯ В ПРОСТРАНСТВЕ</div><div className="usage-metric"><strong>{usage?.today.totalReq ?? 0}</strong><span>запросов к ИИ</span></div><div className="usage-small"><span>Токенов использовано</span><strong>{new Intl.NumberFormat("ru").format(usage?.today.totalTokens ?? 0)}</strong></div><div className="usage-small"><span>Обращений к поиску памяти</span><strong>{usage?.today.embeddingReq ?? 0}</strong></div><div className="usage-small"><span>Ошибок провайдера</span><strong>{usage?.today.errors ?? 0}</strong></div><div className="settings-divider" /><details className="settings-advanced"><summary>Лимиты обращений к ИИ</summary><SettingToggle title="Дневные лимиты" description="Ограничивать число обращений к сервисам." value={draft.enforceLimits} onChange={(value) => change("enforceLimits", value)} /><SettingToggle title="Ключи одного проекта" description="Общий бюджет для всех ключей. Отключайте только для действительно независимых проектов Google." value={draft.keysSharedProject} onChange={(value) => change("keysSharedProject", value)} /><div className="fields quota-fields"><label className="field"><span>Эмбеддинги · в сутки</span><input type="number" min={0} max={1000000} value={draft.dailyEmbeddingLimit} onChange={(e) => change("dailyEmbeddingLimit", Math.max(0, Number(e.target.value)))} /></label><label className="field"><span>Flash · на модель в сутки</span><input type="number" min={0} max={100000} value={draft.dailyFlashLimit} onChange={(e) => change("dailyFlashLimit", Math.max(0, Number(e.target.value)))} /></label><label className="field"><span>Flash Lite · в сутки</span><input type="number" min={0} max={1000000} value={draft.dailyLiteLimit} onChange={(e) => change("dailyLiteLimit", Math.max(0, Number(e.target.value)))} /></label></div><p className="settings-footnote">Это ваши ограничения, не обещание квот провайдера. Реальные лимиты зависят от проекта и тарифа провайдера.</p></details></div><div className="settings-tip"><Sparkles size={22} /><h3>Начать можно без ключа</h3><p>Авторские пресеты доступны в базовом режиме. Подключите рассказчика, когда захотите больше свободы и диалогов.</p>{!onClose && <Link href="/worlds" className="text-link">Выбрать мир <ArrowRight size={13} /></Link>}</div>{administration && <div className="settings-card"><h3>Для разработки</h3><p>Экспериментальная проверка извлечённой памяти через Jev. Оценки не меняют канон.</p><button className="button secondary" disabled={saving} onClick={openDeveloper}>Для разработки <ArrowRight size={13} /></button></div>}<div className="privacy-note"><LockKeyhole size={16} /><p>Аккаунт необязателен. Приватные кампании защищены проверкой владельца; сохранённые API-ключи зашифрованы на сервере.</p></div></aside></div><footer className="workspace-footer"><span><ShieldCheck size={13} />Ваши истории сохраняются на сервере.</span>{!onClose && <Link href="/blueprint">Как устроен движок <ArrowRight size={12} /></Link>}</footer></div>;
}
function SettingToggle({ title, description, value, onChange }: { title: string; description: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="setting-toggle-row"><div><h3>{title}</h3><p>{description}</p></div><button className={`toggle-switch ${value ? "on" : ""}`} role="switch" aria-checked={value} aria-label={title} onClick={() => onChange(!value)}><span /></button></div>;
}

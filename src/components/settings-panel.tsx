"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DeveloperSettings } from "./developer-settings";
import { NarrativeSettings } from "./narrative-settings";
import { useDirtyHistory } from "./use-dirty-history";
import { ArrowRight, BookOpenText, BrainCircuit, Check, ChevronDown, Crown, Database, Eye, EyeOff, ExternalLink, KeyRound, Leaf, LoaderCircle, LockKeyhole, Save, Settings2, ShieldCheck, Sparkles, Trash2, UserRound, Wifi, Zap } from "lucide-react";
import { useApp } from "./app-shell";
import { api, jsonBody } from "@/lib/api-client";
import type { Settings } from "@/lib/ui-data";
import { MODEL_CATALOG } from "@/lib/gemini";
import { READING_OPTIONS } from "@/lib/reading-preferences";
import type { ReadingPreferences } from "@/db/schema";
type Usage = { today: { totalReq: number; totalTokens: number; errors: number; embeddingReq: number }; quotas: { note: string } };
export type SettingsPanelProps = { onClose?: () => void; returnLabel?: string; onCloseReady?: (close: (() => void) | null) => void };
export function SettingsPanel(props: SettingsPanelProps) {
  const { settings, loading, refresh } = useApp();
  const [developer, setDeveloper] = useState(false);
  if (!settings) return <div className="play-loading"><LoaderCircle className="spin" size={27} /><h2>Загружаем настройки…</h2>{!loading && <button className="button secondary" onClick={() => void refresh()}>Попробовать снова</button>}</div>;
  if (developer) return <DeveloperSettings onClose={() => setDeveloper(false)} returnLabel="Назад к настройкам" onCloseReady={props.onCloseReady} />;
  return <SettingsForm {...props} onDeveloper={() => setDeveloper(true)} />;
}
function SettingsForm({ onClose, returnLabel = "Вернуться", onCloseReady, onDeveloper }: SettingsPanelProps & { onDeveloper: () => void }) {
  const router = useRouter();
  const { settings, workspace, refresh, notify, updateReading } = useApp();
  const [draft, setDraft] = useState<Settings>(settings!);
  const [baseline, setBaseline] = useState(JSON.stringify(settings));
  const [confirmClose, setConfirmClose] = useState(false);
  const closeAction = useRef(onClose);
  const [keyText, setKeyText] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [name, setName] = useState(workspace.displayName);
  const [saving, setSaving] = useState(false);
  const [narrativeDirty, setNarrativeDirty] = useState(false);
  const narrativeSave = useRef<(() => Promise<boolean>) | null>(null);
  const onNarrativeSaveReady = useCallback((save: (() => Promise<boolean>) | null) => { narrativeSave.current = save; }, []);
  const [testing, setTesting] = useState(false);
  const [connection, setConnection] = useState<{ ok: boolean; message: string } | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => { api<Usage>("/api/tokens/stats").then(setUsage).catch(() => {}); }, []);
  function change<K extends keyof Settings>(key: K, value: Settings[K]) { setDraft((old) => ({ ...old, [key]: value })); }
  const save = async () => {
    if (!draft) return false; setSaving(true);
    try {
      if (narrativeSave.current && !await narrativeSave.current()) return false;
      await api("/api/settings", jsonBody({ ...draft, embeddingModel: "gemini-embedding-2", ...(keyText.trim() ? { keysText: keyText, append: true, useLiveAI: true } : {}) }));
      const saved = await api<Settings>("/api/settings"); setDraft(saved); setBaseline(JSON.stringify(saved));
      setKeyText(""); await refresh(); notify("Настройки сохранены. Ваш мир готов к новым историям."); return true;
    } catch (e) { notify(e instanceof Error ? e.message : "Не удалось сохранить настройки", true); return false; } finally { setSaving(false); }
  };
  const test = async () => {
    setTesting(true); setConnection(null);
    try { const result = await api<{ model: string; dims: number; latencyMs: number }>("/api/settings/test", jsonBody({})); setConnection({ ok: true, message: `Подключение работает · ${result.model} · ${result.dims} измерений · ${result.latencyMs} мс` }); }
    catch (e) { setConnection({ ok: false, message: e instanceof Error ? e.message : "Подключение не удалось" }); } finally { setTesting(false); }
  };
  const removeKey = async (index: number) => { try { await api("/api/settings", jsonBody({ removeIndex: [index] })); const saved = await api<Settings>("/api/settings"); setDraft(old => ({ ...old, keysCount: saved.keysCount, keysMasked: saved.keysMasked, envKeysCount: saved.envKeysCount, useLiveAI: saved.keysCount + saved.envKeysCount === 0 ? false : old.useLiveAI !== JSON.parse(baseline).useLiveAI ? old.useLiveAI : saved.useLiveAI })); setBaseline(old => JSON.stringify({ ...JSON.parse(old), keysCount: saved.keysCount, keysMasked: saved.keysMasked, envKeysCount: saved.envKeysCount, useLiveAI: saved.useLiveAI })); await refresh(); notify("Ключ удалён"); } catch (e) { notify(e instanceof Error ? e.message : "Ошибка", true); } };
  const saveProfile = async () => { setSaving(true); try { await api("/api/workspace", { method: "PATCH", body: JSON.stringify({ displayName: name }) }); await refresh(); notify("Имя профиля сохранено"); } catch (e) { notify(e instanceof Error ? e.message : "Ошибка", true); } finally { setSaving(false); } };
  const dirty = JSON.stringify(draft) !== baseline || !!keyText.trim() || name !== workspace.displayName || narrativeDirty;
  const releaseHistory = useDirtyHistory(dirty, leave => { closeAction.current = leave; setConfirmClose(true); }, onClose);
  const requestClose = useCallback(() => { if (saving) return; closeAction.current = () => releaseHistory(onClose); if (dirty) setConfirmClose(true); else releaseHistory(onClose); }, [dirty, saving, onClose, releaseHistory]);
  const openDeveloper = () => { if (saving) return; closeAction.current = () => releaseHistory(onDeveloper); if (dirty) setConfirmClose(true); else releaseHistory(onDeveloper); };
  useEffect(() => { onCloseReady?.(requestClose); return () => onCloseReady?.(null); }, [onCloseReady, requestClose]);
  useEffect(() => { if (!dirty) return; const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); }; window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard); }, [dirty]);
  useEffect(() => {
    if (!dirty || onClose) return;
    const guard = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank" || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      event.preventDefault(); event.stopPropagation();
      closeAction.current = () => releaseHistory(() => router.push(url.pathname + url.search + url.hash));
      setConfirmClose(true);
    };
    document.addEventListener("click", guard, true);
    return () => document.removeEventListener("click", guard, true);
  }, [dirty, onClose, releaseHistory, router]);
  const saveAndClose = async () => {
    if (await save()) {
      if (name !== workspace.displayName) {
        try { await api("/api/workspace", { method: "PATCH", body: JSON.stringify({ displayName: name }) }); await refresh(); }
        catch { notify("Не удалось сохранить имя профиля", true); return; }
      }
      closeAction.current?.();
    }
  };
  const totalKeys = draft.keysCount + draft.envKeysCount;
  return <div className="settings-page"><div className="notice"><ShieldCheck size={18} /><p>Ваш гостевой профиль: настройки, ключи и приватные кампании доступны только в этом браузере. Сохраните cookie: её очистка или другой браузер создадут новый профиль.</p></div>{onClose && <div className="settings-return"><button className="button secondary" onClick={requestClose} disabled={saving}>{returnLabel}</button></div>}{confirmClose && <section className="notice settings-unsaved" role="alert"><div><strong>Есть несохранённые изменения</strong><p>Сохраните их перед возвращением или продолжите редактирование.</p><div className="settings-close-actions"><button className="button primary" disabled={saving} onClick={() => void saveAndClose()}>Сохранить и вернуться</button><button className="button secondary" disabled={saving} onClick={() => closeAction.current?.()}>Отбросить и вернуться</button><button className="text-button" onClick={() => setConfirmClose(false)}>Продолжить редактирование</button></div></div></section>}<div className="page-heading"><div><div className="eyebrow">ДВИЖОК ВАШЕГО ВООБРАЖЕНИЯ</div><h1>Настройки пространства</h1><p>Настройте ИИ-мастера, память и темп ваших историй.</p></div><button className="button primary" disabled={saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}<span>Сохранить настройки</span></button></div><div className="settings-layout"><div className="settings-main"><section className="settings-card"><div className="settings-card-heading"><span className="feature-icon violet"><KeyRound size={20} /></span><div><h2>Подключение Gemini</h2><p>Один ключ открывает живое повествование и семантическую память.</p></div><span className={`pill ${totalKeys ? "teal" : "amber"}`}>{totalKeys ? "Ключ сохранён" : "Не подключено"}</span></div><div className="key-input-row"><label className="field"><span>API-ключ Google AI Studio</span><div className="password-input"><input type={showKey ? "text" : "password"} autoComplete="off" spellCheck={false} maxLength={300} placeholder="Вставьте ваш API-ключ" value={keyText} onChange={(e) => setKeyText(e.target.value)} aria-label="API-ключ Gemini" /><button className="icon-button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? "Скрыть ключ" : "Показать ключ"}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label><button className="button primary" disabled={!keyText.trim() || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}Подключить</button></div><div className="key-footnote"><span><LockKeyhole size={12} />Ключ используется только на сервере</span><a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Получить API-ключ <ExternalLink size={11} /></a></div>{draft.keysMasked.map((key, index) => <div className="saved-key" key={`${key}-${index}`}><KeyRound size={13} /><code>{key}</code><span>Ключ {index + 1}</span><button className="icon-button" onClick={() => void removeKey(index)} aria-label={`Удалить ключ ${index + 1}`}><Trash2 size={13} /></button></div>)}{draft.envKeysCount > 0 && <div className="saved-key"><ShieldCheck size={13} /><span>{draft.envKeysCount} ключей из окружения</span><small>Управляются сервером</small></div>}<div className="settings-divider" /><SettingToggle title="Живой ИИ-мастер" description="Свободные истории, живые диалоги и осмысленные последствия." value={draft.useLiveAI} onChange={(value) => { if (!totalKeys && !keyText) { notify("Сначала добавьте и сохраните API-ключ", true); return; } change("useLiveAI", value); }} /><div className="connection-test"><button className="button secondary" disabled={testing || !totalKeys} onClick={() => void test()}>{testing ? <LoaderCircle size={14} className="spin" /> : <Wifi size={14} />}{testing ? "Проверяем…" : "Проверить подключение"}</button><span>Реальный запрос к gemini-embedding-2</span></div>{connection && <div className={`notice ${connection.ok ? "" : "error-notice"}`} role="status">{connection.ok ? <Check size={15} /> : <ShieldCheck size={15} />}<p>{connection.message}</p></div>}</section>
      <section className="settings-card"><div className="settings-card-heading"><span className="feature-icon amber"><Sparkles size={20} /></span><div><h2>Характер вашего рассказчика</h2><p>Баланс глубины повествования, скорости ответа и расхода токенов.</p></div></div><div className="routing-options">{[{ id: "economy", title: "Лёгкое перо", text: "Flash Lite для ходов. Меньше расход, быстрее история.", icon: Leaf }, { id: "balanced", title: "Золотая середина", text: "Lite для простого. Flash для решений, которые меняют всё.", icon: Zap }, { id: "flagship", title: "Большой роман", text: "Flash для каждого хода. Больше деталей и внимания к нюансам.", icon: Crown }].map((profile) => <button key={profile.id} className={`routing-option ${draft.routingProfile === profile.id ? "selected" : ""}`} onClick={() => change("routingProfile", profile.id)}><profile.icon size={20} /><strong>{profile.title}</strong><p>{profile.text}</p>{profile.id === "balanced" && <span className="recommended">РЕКОМЕНДУЕМ</span>}<span className="radio-dot">{draft.routingProfile === profile.id && <Check size={9} />}</span></button>)}</div><details className="advanced-models"><summary>Ручное назначение моделей <ChevronDown size={13} /></summary><div className="fields">{[{ key: "narrationModel", title: "Предложенные действия" }, { key: "customActionModel", title: "Свободные действия" }, { key: "compactionModel", title: "Обобщение памяти" }, { key: "fastTaskModel", title: "Извлечение фактов" }].map(({ key, title }) => <label className="field" key={key}><span>{title}</span><select value={String(draft[key as keyof Settings])} onChange={(e) => { change(key as keyof Settings, e.target.value); change("routingProfile", "custom"); }}>{MODEL_CATALOG.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>)}</div></details></section>
      <section className="settings-card"><div className="settings-card-heading"><span className="feature-icon teal"><BrainCircuit size={20} /></span><div><h2>Память, которая держит нить</h2><p>Сохраняем факты и находим нужные воспоминания по смыслу.</p></div></div><SettingToggle title="Семантическая память" description="Индексировать факты и извлекать релевантный контекст перед ходом." value={draft.embeddingsEnabled} onChange={(value) => change("embeddingsEnabled", value)} /><div className="field-pair embedding-fields"><label className="field"><span>Модель эмбеддингов</span><input value="gemini-embedding-2" readOnly /></label><label className="field"><span>Размерность вектора</span><select value={draft.embeddingDims} onChange={(e) => change("embeddingDims", Number(e.target.value))}><option value={768}>768 · рекомендуем</option><option value={1536}>1536 · больше деталей</option><option value={3072}>3072 · полная размерность</option></select></label></div><div className="setting-explainer"><ShieldCheck size={13} /><span>Поиск изолирован внутри кампании. Векторы разных моделей не смешиваются.</span></div><div className="settings-divider" /><SettingToggle title="Извлечение фактов" description="ИИ выделяет факты из ответа рассказчика. Сервер проверяет цитату-источник." value={draft.semanticExtractionEnabled} onChange={(value) => change("semanticExtractionEnabled", value)} /><p className="settings-footnote">После изменения размерности обновите индекс на странице «Память мира». До этого старые векторы не участвуют в поиске.</p></section>
      <section className="settings-card" id="reading"><div className="settings-card-heading"><span className="feature-icon teal"><BookOpenText size={20} /></span><div><h2>Комфорт чтения</h2><p>История — это прежде всего текст. Настройте его под себя: изменения применяются сразу и сохраняются на сервере.</p></div></div><div className="reading-groups">{([
        { key: "textScale", title: "Размер прозы" },
        { key: "measure", title: "Ширина строки" },
        { key: "theme", title: "Палитра" },
        { key: "motion", title: "Анимации" },
      ] as { key: keyof ReadingPreferences; title: string }[]).map((group) => <div className="reading-group" key={group.key}><span>{group.title}</span><div className="reading-choices">{READING_OPTIONS[group.key].map((option) => <button type="button" key={option.value} className={`reading-choice ${workspace.reading[group.key] === option.value ? "selected" : ""}`} aria-pressed={workspace.reading[group.key] === option.value} onClick={() => void updateReading({ ...workspace.reading, [group.key]: option.value })}><strong>{option.label}</strong><small>{option.hint}</small></button>)}</div></div>)}</div><div className="reading-preview"><small>Предпросмотр</small><p>Туман стелется над причалом, и где-то в тишине бьёт колокол. Вы делаете шаг вперёд — история запоминает каждое ваше решение.</p></div></section>
      <NarrativeSettings onDirtyChange={setNarrativeDirty} onSaveReady={onNarrativeSaveReady} />
      <section className="settings-card" id="profile"><div className="settings-card-heading"><span className="feature-icon violet"><UserRound size={20} /></span><div><h2>Как к вам обращаться?</h2><p>Небольшая деталь, которая делает пространство вашим.</p></div></div><div className="profile-edit"><span className="avatar">{name[0] || "И"}</span><label className="field"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Имя профиля" /></label><button className="button secondary" disabled={saving || !name.trim()} onClick={() => void saveProfile()}>Сохранить</button></div></section>
    </div><aside className="settings-aside"><div className="settings-card usage-card"><div className="side-section-title no-top-margin"><Database size={14} />СЕГОДНЯ В ПРОСТРАНСТВЕ</div><div className="usage-metric"><strong>{usage?.today.totalReq ?? 0}</strong><span>запросов к AI</span></div><div className="usage-small"><span>Токенов использовано</span><strong>{new Intl.NumberFormat("ru").format(usage?.today.totalTokens ?? 0)}</strong></div><div className="usage-small"><span>Запросов embeddings</span><strong>{usage?.today.embeddingReq ?? 0}</strong></div><div className="usage-small"><span>Ошибок провайдера</span><strong>{usage?.today.errors ?? 0}</strong></div><div className="settings-divider" /><SettingToggle title="Дневные лимиты" description="Ограничивать генеративные запросы на сервере." value={draft.enforceLimits} onChange={(value) => change("enforceLimits", value)} /><div className="fields quota-fields"><label className="field"><span>Flash · на модель и ключ</span><input type="number" min={1} max={100000} value={draft.dailyFlashLimit} onChange={(e) => change("dailyFlashLimit", Math.max(1, Number(e.target.value)))} /></label><label className="field"><span>Flash Lite · на ключ</span><input type="number" min={1} max={1000000} value={draft.dailyLiteLimit} onChange={(e) => change("dailyLiteLimit", Math.max(1, Number(e.target.value)))} /></label></div><p className="settings-footnote">Это ваши ограничения, не обещание квот Google. Реальные лимиты зависят от проекта и тарифа провайдера.</p></div><div className="settings-tip"><Sparkles size={22} /><h3>Начать можно без ключа</h3><p>Авторские пресеты доступны в автономном режиме. Подключите Gemini, когда захотите больше свободы и живых диалогов.</p>{!onClose && <Link href="/worlds" className="text-link">Выбрать мир <ArrowRight size={13} /></Link>}</div><div className="settings-card"><h3>Для разработки</h3><p>Экспериментальная проверка извлечённой памяти через Jev. Оценки не меняют канон.</p><button className="button secondary" disabled={saving} onClick={openDeveloper}>Для разработки <ArrowRight size={13} /></button></div><div className="privacy-note"><LockKeyhole size={16} /><p>Приватное пространство для одного владельца. Перед публичным размещением необходимы авторизация и шифрование ключей в БД.</p></div></aside></div><footer className="workspace-footer"><span><ShieldCheck size={13} />Ваши истории хранятся в PostgreSQL.</span>{!onClose && <Link href="/blueprint">Как устроен движок <ArrowRight size={12} /></Link>}</footer></div>;
}
function SettingToggle({ title, description, value, onChange }: { title: string; description: string; value: boolean; onChange: (value: boolean) => void }) {
  return <div className="setting-toggle-row"><div><h3>{title}</h3><p>{description}</p></div><button className={`toggle-switch ${value ? "on" : ""}`} role="switch" aria-checked={value} aria-label={title} onClick={() => onChange(!value)}><span /></button></div>;
}

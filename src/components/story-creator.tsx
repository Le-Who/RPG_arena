"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, BookOpen, Check, Dices, Feather, Globe2, LoaderCircle, MapPin, ShieldCheck, Sparkles, UserRound, Zap } from "lucide-react";
import { Dialog } from "./dialog";
import { api, jsonBody } from "@/lib/api-client";
import { WORLDS, ART, coverFor, PROFILE_LABELS, PROFILE_DESCRIPTIONS, type Session } from "@/lib/ui-data";
import { ARCHETYPES, TONE_PRESETS } from "@/lib/scenarios";
import { canApplyStoryDraftPatch, storyDraftCreationError, type StoryTextField, type StoryDraft, type StoryDraftPatch } from "@/lib/story-draft";

const INITIAL_FORM: StoryDraft = { title: "", worldName: "", pitch: "", era: "", tone: "", mainQuest: "", startLocation: "", name: "", archetype: "", backstory: "", skills: "", startItems: "", rulesProfile: "narrative" };

type StoryCreatorProps = {
  initialScenario?: string;
  initialMode: "preset" | "free";
  onClose: () => void;
  onCreated: () => Promise<void>;
  live: boolean;
  onSettings?: () => void;
  suspended?: boolean;
};

export function StoryCreator({ initialScenario, initialMode, onClose, onCreated, live, onSettings, suspended = false }: StoryCreatorProps) {
  const router = useRouter();
  const [mode, setMode] = useState(initialMode);
  const [scenarioId, setScenarioId] = useState(initialScenario ?? WORLDS[0].id);
  const [characterIndex, setCharacterIndex] = useState(0);
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [autofillBusy, setAutofillBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState<StoryDraft>(INITIAL_FORM);
  const formRef = useRef(form);
  const formElement = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formElement.current?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[name]").forEach(control => {
      control.setCustomValidity(storyDraftCreationError(control.name as StoryTextField, control.value));
    });
  }, [form, step, mode]);
  const modeRef = useRef(mode);
  const autofillRequestRef = useRef(0);
  const autofillAbortRef = useRef<AbortController | null>(null);
  const autofillLockedRef = useRef(false);
  const scenario = WORLDS.find((s) => s.id === scenarioId) ?? WORLDS[0];
  const cancelAutofill = () => {
    autofillRequestRef.current += 1;
    autofillAbortRef.current?.abort();
    autofillAbortRef.current = null;
    autofillLockedRef.current = false;
    setAutofillBusy(false);
  };
  const set = (key: keyof StoryDraft, value: string) => {
    cancelAutofill();
    setForm((old) => {
      const next = { ...old, [key]: value } as StoryDraft;
      formRef.current = next;
      return next;
    });
  };
  const changeMode = (next: "preset" | "free") => {
    cancelAutofill();
    modeRef.current = next;
    setMode(next);
    setError("");
  };
  const close = () => { cancelAutofill(); onClose(); };
  useEffect(() => () => { autofillRequestRef.current += 1; autofillAbortRef.current?.abort(); }, []);
  const autofill = async () => {
    if (busy || autofillLockedRef.current) return;
    if (!live) {
      setError("Для автозаполнения подключите и включите Gemini в настройках.");
      onSettings?.();
      return;
    }
    const requestId = autofillRequestRef.current + 1;
    autofillRequestRef.current = requestId;
    const requested = { ...formRef.current };
    const requestedMode = modeRef.current;
    const controller = new AbortController();
    autofillAbortRef.current = controller;
    autofillLockedRef.current = true;
    setAutofillBusy(true);
    setError("");
    try {
      const result = await api<{ patch: StoryDraftPatch; modelUsed: string }>("/api/story-drafts/autofill", { ...jsonBody({ draft: requested }), signal: controller.signal });
      if (!canApplyStoryDraftPatch({ requested, current: formRef.current, requestedMode, currentMode: modeRef.current, requestId, currentRequestId: autofillRequestRef.current })) return;
      setForm((current) => {
        if (!canApplyStoryDraftPatch({ requested, current, requestedMode, currentMode: modeRef.current, requestId, currentRequestId: autofillRequestRef.current })) return current;
        const next = { ...current, ...result.patch };
        formRef.current = next;
        return next;
      });
    } catch (e) {
      if (requestId === autofillRequestRef.current) setError(e instanceof Error ? e.message : "Не удалось заполнить черновик");
    } finally {
      if (requestId === autofillRequestRef.current) {
        autofillAbortRef.current = null;
        autofillLockedRef.current = false;
        setAutofillBusy(false);
      }
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (mode === "free" && step === 1) { setStep(2); return; }
    setBusy(true); setError("");
    try {
      const body = mode === "preset" ? { mode, scenarioId, characterIndex } : { mode, rulesProfile: form.rulesProfile, customScenario: { title: form.title, worldName: form.worldName || form.title, pitch: form.pitch, era: form.era, tone: form.tone, mainQuest: form.mainQuest, startLocation: form.startLocation }, customCharacter: { name: form.name, archetype: form.archetype, backstory: form.backstory, skills: form.skills.split(",").map((s) => s.trim()).filter(Boolean), startItems: form.startItems.split(",").map((s) => s.trim()).filter(Boolean) } };
      const result = await api<{ session: Session }>("/api/sessions", jsonBody(body));
      await onCreated(); onClose(); router.push(`/play/${result.session.id}`);
    } catch (e) { setError(e instanceof Error ? e.message : "Не удалось создать историю"); setBusy(false); }
  };
  return <Dialog onClose={busy ? () => {} : close} title="Новая история" wide className="creator-dialog" suspended={suspended}><div className="creator-art" style={{ backgroundImage: `url(${mode === "preset" ? coverFor(scenario.id) : "/space-odyssey.webp"})` }}><span className="pill glass"><Globe2 size={13} />{mode === "preset" ? ART[scenario.id].category : "ВАШ СОБСТВЕННЫЙ МИР"}</span><div><span className="eyebrow">{mode === "preset" ? scenario.worldName : "БЕЗ ГРАНИЦ И ШАБЛОНОВ"}</span><h2>{mode === "preset" ? scenario.title : "Всё начинается с чистого листа."}</h2><p>{mode === "preset" ? scenario.pitch : "Город, которого нет на карте. Герой, которого ещё не знают. История, которую можете рассказать только вы."}</p>{mode === "preset" && <div className="creator-world-meta"><span><MapPin size={14} />{scenario.startLocation}</span><span><Dices size={14} />{PROFILE_LABELS[scenario.rulesProfile]}</span><span><ShieldCheck size={14} />Доступен автономный режим</span></div>}</div></div><div className="creator-form"><div className="eyebrow">НОВАЯ КАМПАНИЯ</div><h2>Положим начало истории</h2><div className="segmented"><button type="button" className={mode === "preset" ? "selected" : ""} onClick={() => changeMode("preset")}><BookOpen size={15} />Готовый мир</button><button type="button" className={mode === "free" ? "selected" : ""} onClick={() => changeMode("free")}><Sparkles size={15} />Своя история</button></div><form ref={formElement} onSubmit={submit}>
    {mode === "preset" ? <><label className="field"><span>Выберите мир</span><select value={scenarioId} onChange={(e) => { setScenarioId(e.target.value); setCharacterIndex(0); }}>{WORLDS.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label><div className="field-title">Кем вы станете?</div><div className="character-choices">{scenario.characters.map((character, i) => <button key={character.name} type="button" className={`character-choice ${characterIndex === i ? "selected" : ""}`} onClick={() => setCharacterIndex(i)}><span className="character-mini-avatar"><UserRound size={20} /></span><span><strong>{character.name}</strong><small>{character.archetype}</small></span><span className="radio-dot">{characterIndex === i && <Check size={10} />}</span></button>)}</div><p className="character-story">{scenario.characters[characterIndex].backstory}</p><div className="tag-row">{scenario.characters[characterIndex].skills.map((s) => <span className="tag" key={s}>{s}</span>)}</div><div className="notice subtle"><Dices size={17} /><p><strong>{PROFILE_LABELS[scenario.rulesProfile]}</strong><br />{PROFILE_DESCRIPTIONS[scenario.rulesProfile]}</p></div></> : <><div className="form-step"><span className={step === 1 ? "current" : "complete"}>1 <span>Мир</span></span><i /><span className={step === 2 ? "current" : ""}>2 <span>Герой и правила</span></span></div>{step === 1 ? <div className="fields"><label className="field"><span>Название истории <em>*</em></span><input required maxLength={80} name="title" value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="Например, Дождь над Берлином" /></label><div className="field-pair"><label className="field"><span>Мир или место</span><input maxLength={80} name="worldName" value={form.worldName} onChange={(e) => set("worldName", e.target.value)} placeholder="Берлин" /></label><label className="field"><span>Эпоха</span><input maxLength={80} name="era" value={form.era} onChange={(e) => set("era", e.target.value)} placeholder="Осень 1989 года" /></label></div><label className="field"><span>Завязка истории <em>*</em></span><textarea required minLength={15} maxLength={2000} name="pitch" value={form.pitch} onChange={(e) => set("pitch", e.target.value)} rows={3} placeholder="Что происходит в этом мире? Какая тайна, встреча или событие изменит вашу жизнь?" /></label><label className="field"><span>Тон повествования</span><input list="story-tones" name="tone" value={form.tone} onChange={(e) => set("tone", e.target.value)} maxLength={80} placeholder="Выберите тон или оставьте генератору" /><datalist id="story-tones">{TONE_PRESETS.map((tone) => <option key={tone} value={tone} />)}</datalist></label><div className="field-pair"><label className="field"><span>Цель героя</span><input maxLength={500} name="mainQuest" value={form.mainQuest} onChange={(e) => set("mainQuest", e.target.value)} placeholder="Найти пропавшего брата" /></label><label className="field"><span>Стартовая локация</span><input maxLength={80} name="startLocation" value={form.startLocation} onChange={(e) => set("startLocation", e.target.value)} placeholder="Кафе у вокзала" /></label></div></div> : <div className="fields"><div className="field-pair"><label className="field"><span>Имя героя <em>*</em></span><input required maxLength={40} name="name" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Как вас зовут?" /></label><label className="field"><span>Роль</span><input list="archetypes" maxLength={40} name="archetype" value={form.archetype} onChange={(e) => set("archetype", e.target.value)} placeholder="Выберите роль или оставьте генератору" /><datalist id="archetypes">{ARCHETYPES.map((a) => <option key={a} value={a} />)}</datalist></label></div><label className="field"><span>Предыстория</span><textarea rows={2} maxLength={800} name="backstory" value={form.backstory} onChange={(e) => set("backstory", e.target.value)} placeholder="Что привело вас сюда?" /></label><div className="field-pair"><label className="field"><span>Навыки, через запятую</span><input name="skills" value={form.skills} onChange={(e) => set("skills", e.target.value)} maxLength={240} placeholder="Анализ, переговоры" /></label><label className="field"><span>Вещи с собой</span><input name="startItems" value={form.startItems} onChange={(e) => set("startItems", e.target.value)} maxLength={360} placeholder="Блокнот, фотоаппарат" /></label></div><div className="field-title">Как устроена ваша история?</div><div className="rules-choices">{[{ id: "narrative", icon: Feather }, { id: "rules-light", icon: Zap }, { id: "d20", icon: Dices }].map((p) => <button type="button" key={p.id} className={`rules-choice ${form.rulesProfile === p.id ? "selected" : ""}`} onClick={() => set("rulesProfile", p.id)}><p.icon size={18} /><span><strong>{PROFILE_LABELS[p.id]}</strong><small>{PROFILE_DESCRIPTIONS[p.id]}</small></span><span className="radio-dot">{form.rulesProfile === p.id && <Check size={10} />}</span></button>)}</div>{!live && <div className="notice amber"><Sparkles size={16} /><p>Мир можно сохранить сейчас. Для первого хода потребуется <button type="button" className="text-link" onClick={() => onSettings?.()}>подключить Gemini</button>.</p></div>}</div>}</>}
    {error && <div className="form-error" role="alert">{error}</div>}<div className="creator-submit">{mode === "free" && step === 2 && <button type="button" className="button secondary icon-only" onClick={() => setStep(1)} aria-label="Назад к миру"><ArrowLeft size={18} /></button>}{mode === "free" && <button type="button" className="button secondary full-width" disabled={busy || autofillBusy} onClick={() => void autofill()}>{autofillBusy ? <><LoaderCircle size={16} className="spin" />Заполняем…</> : <><Sparkles size={16} />Заполнить пустые поля</>}</button>}<button className="button primary full-width" disabled={busy || autofillBusy}>{busy ? <><LoaderCircle size={16} className="spin" />Создаём ваш мир…</> : mode === "free" && step === 1 ? <>Далее: герой и правила <ArrowRight size={16} /></> : <>Начать историю <ArrowRight size={16} /></>}</button></div><p className="form-footnote"><ShieldCheck size={12} />Прогресс сохраняется автоматически</p></form></div></Dialog>;
}

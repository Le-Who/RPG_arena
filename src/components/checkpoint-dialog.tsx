"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowRight, BookmarkPlus, Check, ChevronDown, Clock3, GitBranch, GitFork, LoaderCircle, MapPin, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { Dialog } from "./dialog";
import { useApp } from "./app-shell";
import { api, jsonBody } from "@/lib/api-client";
import type { CheckpointSummary } from "@/lib/checkpoint-types";
import type { Session } from "@/lib/ui-data";
export function CheckpointDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const router = useRouter(); const { refresh, notify } = useApp();
  const [points, setPoints] = useState<CheckpointSummary[]>([]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [title, setTitle] = useState(`Перед следующим шагом · ход ${session.turnCount}`);
  const [selected, setSelected] = useState<CheckpointSummary | null>(null);
  const [branchTitle, setBranchTitle] = useState(""); const [remove, setRemove] = useState<string | null>(null);
  const saveRequest = useRef<{ title: string; id: string } | null>(null);
  const forkRequest = useRef<{ point: string; title: string; id: string } | null>(null);
  const load = useCallback(async () => {
    const data = await api<{ checkpoints: CheckpointSummary[] }>(`/api/sessions/${session.id}/checkpoints`); setPoints(data.checkpoints);
  }, [session.id]);
  useEffect(() => { let active = true; api<{ checkpoints: CheckpointSummary[] }>(`/api/sessions/${session.id}/checkpoints`).then((data) => { if (active) setPoints(data.checkpoints); }).catch((e) => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [session.id]);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (busy || !title.trim()) return; setBusy(true); setError("");
    if (saveRequest.current?.title !== title.trim()) saveRequest.current = { title: title.trim(), id: crypto.randomUUID() };
    try { await api(`/api/sessions/${session.id}/checkpoints`, jsonBody({ title: title.trim(), expectedTurn: session.turnCount, requestId: saveRequest.current.id })); await load(); saveRequest.current = null; notify("Развилка сохранена вместе с миром, героями и памятью"); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить точку"); } finally { setBusy(false); }
  };
  const fork = async (event: FormEvent) => {
    event.preventDefault(); if (!selected || !branchTitle.trim() || busy) return; setBusy(true); setError("");
    if (forkRequest.current?.point !== selected.id || forkRequest.current.title !== branchTitle.trim()) forkRequest.current = { point: selected.id, title: branchTitle.trim(), id: crypto.randomUUID() };
    try { const result = await api<{ session: Session }>(`/api/sessions/${session.id}/checkpoints/${selected.id}/fork`, jsonBody({ title: branchTitle.trim(), requestId: forkRequest.current.id })); await refresh(); notify("Новая ветка готова. Исходная история не изменилась."); onClose(); router.push(`/play/${result.session.id}`); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось создать ветку"); setBusy(false); }
  };
  const deletePoint = async (id: string) => {
    setBusy(true); setError("");
    try { await api(`/api/sessions/${session.id}/checkpoints/${id}`, { method: "DELETE" }); await load(); setRemove(null); notify("Точка удалена. Её ветки остались независимыми историями."); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось удалить точку"); } finally { setBusy(false); }
  };
  return <Dialog onClose={busy ? () => {} : onClose} title="Развилки истории" wide className="checkpoint-dialog"><div className="checkpoint-hero"><div><span className="pill violet"><GitBranch size={12} />РАЗВИЛКИ ИСТОРИИ</span><h2>А что, если<br /><span>пойти другим путём?</span></h2><p>Сохраните этот момент. Попробуйте другое решение.<br />У каждой версии вашей истории будет свой мир и своя память.</p></div><div className="branch-illustration" aria-hidden="true"><i className="branch-line stem" /><i className="branch-line left" /><i className="branch-line right" /><span className="branch-node root"><BookmarkPlus size={19} /></span><span className="branch-node path-left"><GitBranch size={20} /></span><span className="branch-node path-right"><SparkleIcon /></span><small>ОДИН МОМЕНТ · НОВЫЕ ВОЗМОЖНОСТИ</small></div></div><div className="checkpoint-content">
    {selected ? <div className="branch-create"><button className="text-button" onClick={() => { setSelected(null); setError(""); }} disabled={busy}>← К контрольным точкам</button><div className="branch-source"><span className="feature-icon violet"><GitFork size={22} /></span><div><small>НОВАЯ ВЕТКА ИЗ ТОЧКИ</small><h3>{selected.title}</h3><p>Ход {selected.turnNumber} · {selected.summary.location}</p></div></div><form onSubmit={fork}><label className="field"><span>Название новой истории</span><input required maxLength={80} value={branchTitle} onChange={(e) => setBranchTitle(e.target.value)} autoFocus placeholder="Например, Если бы я остался" /></label><div className="notice"><ShieldCheck size={16} /><p>В новую кампанию попадут только события и память, сохранённые в этой точке. Последующие ходы исходной истории не переносятся. Её можно продолжать независимо.</p></div>{selected.summary.pendingFacts > 0 && <p className="checkpoint-footnote">При сохранении точки {selected.summary.pendingFacts} заданий извлечения ещё ожидали обработки. Их будущие результаты не входят в снимок.</p>}<button className="button primary full-width" disabled={busy || !branchTitle.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <GitFork size={16} />}Создать независимую ветку <ArrowRight size={14} /></button></form></div> : <><div className="checkpoint-current"><div><span className="current-dot" /><strong>Вы здесь: ход {session.turnCount}</strong><span>{session.character.name} · {session.worldState.currentLocation}</span></div><span className="mini-tag">ПОДТВЕРЖДЁННЫЙ МИР</span></div><form onSubmit={save} className="checkpoint-save"><label className="field"><span>Как назовём этот момент?</span><input required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Перед важным решением" /></label><button className="button primary" disabled={busy || points.length >= 12 || !title.trim()}>{busy ? <LoaderCircle size={15} className="spin" /> : <BookmarkPlus size={16} />}Сохранить точку</button></form><div className="checkpoint-list-heading"><h3>Моменты, к которым можно вернуться</h3><span>{points.length} / 12</span></div>{loading ? <div className="checkpoint-loading"><LoaderCircle size={23} className="spin" />Загружаем сохранённые моменты…</div> : <div className="checkpoint-list">{points.map((point) => <article className="checkpoint-point" key={point.id}><span className="point-marker"><GitBranch size={15} /></span><div className="point-main"><div className="point-heading"><h3>{point.title}</h3><span>Ход {point.turnNumber}</span></div><p><MapPin size={11} />{point.summary.location}</p><div className="point-meta"><span>{point.summary.memories} фактов</span><i /><span>{point.summary.items} предметов</span><i /><span>{new Intl.DateTimeFormat("ru", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(point.createdAt))}</span></div>{point.branches.length > 0 && <div className="point-branches">{point.branches.map((branch) => <Link key={branch.id} href={`/play/${branch.id}`} onClick={onClose}><GitFork size={11} />{branch.title}<ArrowRight size={11} /></Link>)}</div>}{remove === point.id && <div className="point-delete-confirm"><span>Удалить только точку? Её ветки сохранятся.</span><button onClick={() => void deletePoint(point.id)} disabled={busy}>Удалить</button><button onClick={() => setRemove(null)} disabled={busy}>Отмена</button></div>}</div><div className="point-actions"><button className="button secondary" disabled={busy} onClick={() => { setSelected(point); setBranchTitle(`${session.title} · другой путь`.slice(0, 80)); setError(""); }}><GitFork size={13} />Другой путь</button><button className="icon-button" disabled={busy} aria-label={`Удалить точку ${point.title}`} onClick={() => setRemove(point.id)}><Trash2 size={13} /></button></div></article>)}</div>}{!loading && !points.length && <div className="checkpoint-empty"><BookmarkPlus size={24} /><h3>Сохраните момент перед важным выбором</h3><p>Контрольные точки появятся здесь. Они не отменяют действия — они дают возможность начать новую ветку.</p></div>}<div className="checkpoint-bottom-note"><ShieldCheck size={13} />Мир, инвентарь, цели, NPC, журнал и память — в одном снимке.</div></>}
    {error && <div className="form-error" role="alert">{error}<button className="text-button" onClick={() => void load().then(() => setError("")).catch(() => {})} disabled={busy}>Обновить список</button></div>}
    </div></Dialog>;
}
function SparkleIcon() { return <Plus size={23} strokeWidth={1.5} />; }

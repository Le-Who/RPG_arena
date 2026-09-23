"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { ArrowDown, ArrowRight, BookOpen, ChevronLeft, ChevronRight, Compass, Feather, GitBranch, Globe2, MapPin, Play, Plus, RefreshCw, Sparkles, Workflow } from "lucide-react";
import { useApp } from "./app-shell";
import { WorldLibrary } from "./world-library";
import { ART, coverFor, PROFILE_LABELS, WORLDS } from "@/lib/ui-data";

const featured = ["ashen-crown", "neon-pact", "echo-station"];
export function Overview() {
  const { newStory, showGuide, sessions, loading, loadError, refresh } = useApp();
  const [slide, setSlide] = useState(0);
  const world = WORLDS.find(item => item.id === featured[slide])!;
  const active = sessions.filter(session => session.status === "active").slice(0, 2);
  return <div className="overview-page">
    <div className="overview-heading">
      <div><div className="overview-eyebrow"><span />ПРОСТРАНСТВО ДЛЯ ВООБРАЖЕНИЯ</div><h1>Хороший день для новой истории<span>.</span></h1><p>Знакомые миры и неизведанные пути. Куда отправимся сегодня?</p></div>
      <button className="button primary" onClick={() => newStory()}><Plus size={17} />Новая история</button>
    </div>
    {loadError && <div className="notice error-notice" role="alert"><p>Не удалось загрузить ваши истории. {loadError}</p><button className="text-button" onClick={() => void refresh()}><RefreshCw size={15} />Повторить</button></div>}

    <section className={`story-hero hero-slide-${slide}`} aria-label="Вдохновение для новой истории">
      <Image className="story-hero-art" src={coverFor(world.id)} alt={`Пейзаж мира ${world.worldName}`} fill sizes="(max-width:780px) 100vw, calc(100vw - 300px)" preload />
      <div className="story-hero-shade" />
      <div className="story-hero-copy"><span className="hero-kicker"><Sparkles size={13} />ВЫ — ГЛАВНЫЙ ГЕРОЙ</span><h2>Не просто игра.<br /><em>Твоя история.</em></h2><p>Мир оживает с каждым решением.<br />Каким будет след, который оставишь ты?</p><div className="story-hero-actions"><button className="button primary" onClick={() => newStory(world.id)}>Начать приключение <ArrowRight size={16} /></button><button className="hero-guide" onClick={showGuide}><span><Play size={12} fill="currentColor" /></span>Как это работает</button></div></div>
      <span className="hero-art-label"><span />АВТОРСКИЙ МИР</span>
      <div className="hero-world-info"><span className="hero-world-index">0{slide + 1} <span>/ 03</span></span><button onClick={() => newStory(world.id)}><strong>{world.title}</strong><span><MapPin size={12} />{world.worldName} · {ART[world.id].category}</span></button><div className="hero-carousel"><button onClick={() => setSlide((slide + 2) % 3)} aria-label="Предыдущий мир"><ChevronLeft size={17} /></button><button onClick={() => setSlide((slide + 1) % 3)} aria-label="Следующий мир"><ChevronRight size={17} /></button></div></div>
    </section>

    <div className="story-principles">
      <div><span className="principle-icon"><Globe2 size={20} /></span><div><strong>Любой мир. Любая роль.</strong><p>От древней магии до далёких галактик</p></div></div>
      <div><span className="principle-icon"><Workflow size={20} /></span><div><strong>Мир помнит ваши решения</strong><p>Ваши поступки становятся частью истории</p></div></div>
      <div><span className="principle-icon"><GitBranch size={20} /></span><div><strong>Выбор, который меняет всё</strong><p>Сохраняйте моменты. Исследуйте развилки.</p></div></div>
    </div>

    <section className="overview-stories" aria-label="Ваши истории"><div className="section-heading"><h2>Продолжить историю <span className="count-badge">{sessions.filter(session => session.status === "active").length}</span></h2><Link href="/campaigns" className="text-link">Все кампании <ArrowRight size={14} /></Link></div>
      <div className="overview-story-grid">
        {loading ? <div className="overview-loading" role="status"><span className="loading-orbit" />Загружаем ваши истории…</div> : active.length ? active.map(session => <Link href={`/play/${session.id}`} className="recent-story" key={session.id}><Image src={coverFor(session.scenarioId)} alt="" width={100} height={110} /><div><span className="recent-story-meta"><i />В ПУТИ <span>·</span> ГЛАВА {session.worldState.chapter}</span><h3>{session.title}</h3><p>{session.character.name} <span>·</span> {session.character.archetype}</p><div className="recent-story-bottom"><span>{PROFILE_LABELS[session.rulesProfile]}</span><small>Ход {session.turnCount}</small></div></div><span className="recent-story-arrow"><ArrowRight size={18} /></span></Link>) : <button className="recent-story first-story" onClick={() => newStory("ashen-crown")}><Image src={coverFor("ashen-crown")} alt="" width={100} height={110} /><div><span className="recent-story-meta">ВАША ПЕРВАЯ ГЛАВА</span><h3>Приключение ещё впереди</h3><p>Начните с «Пепельной Короны» — ключ AI не нужен.</p><span className="first-story-cta">Выбрать героя <ArrowRight size={13} /></span></div><BookOpen className="first-story-icon" size={20} /></button>}
        {active.length < 2 && <button className="new-story-tile" onClick={() => newStory(undefined, "free")}><span className="new-story-symbol"><Plus size={22} /></span><div><h3>А что, если…</h3><p>У каждой великой истории есть начало.<br />Придумайте своё.</p></div><ArrowRight size={18} /></button>}
      </div>
    </section>

    <WorldLibrary />
    <div className="overview-bottom"><span><Feather size={15} />Хорошие истории не заканчиваются. Они ждут вашего следующего хода.</span><a href="#main-content" aria-label="Вернуться наверх"><ArrowDown size={15} /></a></div>
    <footer className="workspace-footer"><span><Compass size={13} />Сделано для тех, кто любит истории.</span><Link href="/blueprint">Chronicle Engine <span>Обзор возможностей</span><ArrowRight size={12} /></Link></footer>
  </div>;
}

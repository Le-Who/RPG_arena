import Link from "next/link";
import { ArrowLeft, Compass, Globe2 } from "lucide-react";
export default function NotFound() { return <div className="empty-state"><Compass size={35} /><span className="eyebrow">НЕИЗВЕДАННАЯ ТЕРРИТОРИЯ · 404</span><h3>Эта глава ещё не написана</h3><p>Похоже, здесь нет страницы, которую вы искали. Но впереди ещё столько историй.</p><Link href="/" className="button primary"><ArrowLeft size={14} />Вернуться в пространство</Link><Link href="/worlds" className="text-link"><Globe2 size={13} />Найти новый мир</Link></div>; }

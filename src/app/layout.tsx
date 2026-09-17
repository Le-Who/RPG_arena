import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Chronicle Engine — интерактивная новелла со свободой действия",
  description: "Текстовые истории любого жанра: ИИ-мастер, серверная валидация изменений мира, память с provenance и семантическим поиском, профили механик d20 / rules-light / narrative.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body className="min-h-screen antialiased">
        <div className="pointer-events-none fixed inset-0 -z-10">
          <div className="absolute inset-0 bg-[#0b0e1a]" />
          <div className="absolute -top-40 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-violet-700/25 blur-[120px]" />
          <div className="absolute bottom-0 left-0 h-[320px] w-[420px] rounded-full bg-amber-500/10 blur-[100px]" />
          <div className="absolute right-0 top-1/3 h-[300px] w-[300px] rounded-full bg-emerald-500/10 blur-[100px]" />
        </div>
        <header className="sticky top-0 z-40 border-b border-white/10 bg-[#0b0e1a]/80 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <a href="/" className="flex items-center gap-2.5">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-amber-300 to-violet-600 text-lg shadow-lg">📖</span>
              <span>
                <span className="block text-[15px] font-bold tracking-wide text-amber-100">CHRONICLE ENGINE</span>
                <span className="block text-[11px] uppercase tracking-[0.2em] text-violet-300/80">interactive fiction engine</span>
              </span>
            </a>
            <nav className="flex items-center gap-1 text-sm">
              <a href="/" className="rounded-lg px-3 py-2 text-slate-300 hover:bg-white/10 hover:text-white">Истории</a>
              <a href="/blueprint" className="rounded-lg px-3 py-2 text-slate-300 hover:bg-white/10 hover:text-white">Архитектура</a>
              <a href="/settings" className="rounded-lg px-3 py-2 text-slate-300 hover:bg-white/10 hover:text-white">⚙️ Настройки</a>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 pb-20">{children}</main>
        <footer className="border-t border-white/10 py-6 text-center text-xs text-slate-500">
          Chronicle Engine · интерактивная новелла любого жанра · память с provenance · сервер как источник истины
          <span className="mx-2 text-slate-600">·</span>
          <a href="/blueprint" className="underline underline-offset-2 hover:text-slate-400">Blueprint</a>
        </footer>
      </body>
    </html>
  );
}

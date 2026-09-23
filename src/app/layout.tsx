import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import "./globals.css";
import "./shell.css";
import "./pages.css";
import "./theatre.css";
import "./preferences.css";
import "./dialogs.css";
import "./overview.css";
export const metadata: Metadata = {
  title: { default: "Chronicle Engine — Твоя история начинается здесь", template: "%s · Chronicle Engine" },
  description: "Живые миры, ИИ-мастер и свобода каждого решения. Создайте собственную историю или отправьтесь в авторское приключение.",
  icons: { icon: "/icon.svg" },
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="ru"><body><AppShell>{children}</AppShell></body></html>;
}

import type { MetadataRoute } from "next";

// ECO-1c (2.9): метаданные приложения. Офлайн-чтение обеспечивает HTML-книга кампании.
// Service worker отсутствует; полноценная PWA остаётся в roadmap.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Chronicle Engine",
    short_name: "Chronicle",
    description: "Универсальные интерактивные истории с памятью, людьми мира и проверяемыми последствиями.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#14121c",
    theme_color: "#14121c",
    lang: "ru",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}

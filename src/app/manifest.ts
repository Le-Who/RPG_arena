import type { MetadataRoute } from "next";

// ECO-1 (2.10): устанавливаемое приложение. Service worker (/sw.js) кэширует только неизменяемые
// ассеты и статичную офлайн-страницу; /api, HTML-документы и приватные данные в кэш не попадают.
// Офлайн-чтение самой истории по-прежнему обеспечивает скачанная HTML-книга кампании.
const shortcutIcon = [{ src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }];

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Chronicle Engine",
    short_name: "Chronicle",
    description: "Универсальные интерактивные истории с памятью, людьми мира и проверяемыми последствиями.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#14121c",
    theme_color: "#14121c",
    lang: "ru",
    dir: "ltr",
    categories: ["games", "entertainment", "books"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Мои кампании", short_name: "Кампании", url: "/campaigns", icons: shortcutIcon },
      { name: "Библиотека миров", short_name: "Миры", url: "/worlds", icons: shortcutIcon },
    ],
  };
}

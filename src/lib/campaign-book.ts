// ── ECO-1c (2.9): «книга» кампании — самодостаточный HTML для чтения офлайн и печати ──
// Строится из того же Markdown, что и обычный экспорт: один источник содержания, без второго шаблона.
// Файл не содержит скриптов, внешних ресурсов и секретов; всё содержимое экранируется до разметки.
// Граница: книга — только чтение. Продолжение истории требует сервера, состояния мира и рассказчика.

const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Минимальная inline-разметка поверх уже экранированного текста. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(«])\*(?!\s)([^*]+?)\*(?=$|[\s.,;:!?)»])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(«])_(?!\s)([^_]+?)_(?=$|[\s.,;:!?)»])/g, "$1<em>$2</em>");
}

export type BookHeading = { id: string; level: number; text: string };

export function markdownToBookBody(markdown: string): { html: string; headings: BookHeading[] } {
  const out: string[] = [];
  const headings: BookHeading[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let quote: string[] = [];
  const flushParagraph = () => { if (paragraph.length) { out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`); paragraph = []; } };
  const flushList = () => { if (list.length) { out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`); list = []; } };
  const flushQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`); quote = []; } };
  const flush = () => { flushParagraph(); flushList(); flushQuote(); };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min(4, heading[1].length);
      const id = `part-${headings.length + 1}`;
      const text = heading[2].replace(/\s+#+\s*$/, "").trim();
      headings.push({ id, level, text });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flush(); out.push("<hr>"); continue; }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) { flushParagraph(); flushQuote(); list.push(item[1]); continue; }
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    if (!line.trim()) { flush(); continue; }
    flushList(); flushQuote();
    paragraph.push(line.trim());
  }
  flush();
  return { html: out.join("\n"), headings };
}

export function markdownToBookHtml(markdown: string, options: { exportedAt?: Date } = {}): string {
  const { html, headings } = markdownToBookBody(markdown);
  const title = headings.find((h) => h.level === 1)?.text ?? "История Chronicle";
  const toc = headings.filter((h) => h.level === 2);
  const exportedAt = (options.exportedAt ?? new Date()).toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="Chronicle Engine">
<title>${escapeHtml(title)}</title>
<style>
:root { --paper: #fbf8f1; --ink: #25211c; --muted: #6f665b; --line: #e3dccd; --accent: #8a5a2b; }
@media (prefers-color-scheme: dark) { :root { --paper: #16141c; --ink: #ece6da; --muted: #a79f92; --line: #2f2b38; --accent: #d9a86c; } }
* { box-sizing: border-box; }
html { background: var(--paper); color: var(--ink); }
body { margin: 0 auto; max-width: 44rem; padding: 3rem 1.25rem 4rem; font: 1.08rem/1.72 Georgia, "Iowan Old Style", "Times New Roman", serif; }
h1 { font-size: 2.1rem; line-height: 1.2; margin: 0 0 1.5rem; }
h2 { font-size: 1.45rem; margin: 2.6rem 0 1rem; padding-top: 1rem; border-top: 1px solid var(--line); }
h3, h4 { font-size: 1.1rem; margin: 1.8rem 0 .6rem; color: var(--accent); }
p { margin: 0 0 1rem; }
blockquote { margin: 1.2rem 0; padding: .2rem 0 .2rem 1rem; border-left: 3px solid var(--accent); color: var(--muted); font-style: italic; }
ul { padding-left: 1.3rem; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .9em; }
nav { margin: 0 0 2.5rem; padding: 1rem 1.2rem; border: 1px solid var(--line); border-radius: 10px; font-size: .95rem; }
nav ol { margin: .4rem 0 0; padding-left: 1.2rem; }
a { color: var(--accent); }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
@media print { body { max-width: none; padding: 0; font-size: 11.5pt; } nav, footer { display: none; } h2 { break-before: page; border: 0; } a { color: inherit; text-decoration: none; } }
</style>
</head>
<body>
${toc.length > 1 ? `<nav aria-label="Содержание"><strong>Содержание</strong><ol>${toc.map((h) => `<li><a href="#${h.id}">${inline(h.text)}</a></li>`).join("")}</ol></nav>` : ""}
<main>
${html}
</main>
<footer>Экспортировано из Chronicle Engine ${exportedAt}. Файл читается без сети и сервера; продолжение истории требует сервера, состояния мира и рассказчика.</footer>
</body>
</html>
`;
}

import { chromium, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installUiMock, mockSessionId } from "./ui-mock";
const base = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const mock = process.env.UI_AUDIT_MOCK === "1";
const output = "output/playwright";

/** Computes WCAG contrast of every visible text node against its effective background. */
const AUDIT = `(() => {
  // Resolve any CSS color (incl. oklch) to sRGB bytes via canvas.
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const toRGB = (col) => {
    if (cache.has(col)) return cache.get(col);
    ctx.clearRect(0,0,1,1); ctx.fillStyle = '#000';
    ctx.fillStyle = col; ctx.fillRect(0,0,1,1);
    const d = ctx.getImageData(0,0,1,1).data;
    const v = [d[0],d[1],d[2],d[3]/255];
    cache.set(col, v); return v;
  };
  const lum = (c) => { const [r,g,b]=c.slice(0,3).map(v=>{v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4)}); return 0.2126*r+0.7152*g+0.0722*b };
  const mix = (fg, bg) => { const a=fg[3]; return [0,1,2].map(i=>fg[i]*a+bg[i]*(1-a)) };
  const bgOf = (el) => {
    let n = el, acc = null;
    while (n && n !== document.documentElement) {
      const c = toRGB(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) { acc = acc ? mix(acc, c) : c; if (c[3] >= 0.99) return acc.slice(0,3); }
      n = n.parentElement;
    }
    const base = toRGB(getComputedStyle(document.body).backgroundColor);
    return acc ? mix(acc, base) : base.slice(0,3);
  };
  const small = [], low = [], seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const txt = Array.from(el.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent.trim()).join('');
    if (!txt) continue;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.15) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const size = parseFloat(st.fontSize);
    const key = String(el.className) + '|' + size;
    if (size < 12 && !seen.has('s'+key)) { seen.add('s'+key); small.push({ cls: String(el.className).slice(0,52), size:+size.toFixed(1), txt: txt.slice(0,26) }); }
    let grad = false;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (getComputedStyle(n).backgroundImage.includes('gradient')) { grad = true; break; }
      if (toRGB(getComputedStyle(n).backgroundColor)[3] >= 0.99) break;
    }
    if (grad) continue;
    const fgRaw = toRGB(st.color);
    const bg = bgOf(el);
    const fg = fgRaw[3] < 1 ? mix(fgRaw, bg) : fgRaw.slice(0,3);
    const l1 = lum(fg), l2 = lum(bg);
    const cr = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
    const large = size >= 24 || (size >= 18.66 && Number(st.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (cr < need && !seen.has('c'+key)) { seen.add('c'+key); low.push({ cls: String(el.className).slice(0,52), size:+size.toFixed(1), cr:+cr.toFixed(2), need, txt: txt.slice(0,26) }); }
  }
  return { small, low, overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
})()`;

async function audit(page: Page, name: string, path: string, width: number, theme?: string, text?: string) {
  await page.setViewportSize({ width, height: 1100 });
  await page.goto(base + path, { waitUntil: "networkidle" });
  if (theme || text) {
    await page.evaluate(([t, x]) => {
      if (t) document.documentElement.setAttribute("data-theme", t);
      if (x) document.documentElement.setAttribute("data-text", x);
    }, [theme ?? "", text ?? ""]);
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
  const r = await page.evaluate(AUDIT) as { small: unknown[]; low: unknown[]; overflow: boolean };
  console.log(`\n── ${name} @${width}  small:${r.small.length}  lowContrast:${r.low.length}  overflow:${r.overflow}`);
  for (const s of r.small.slice(0, 6)) console.log("   TINY", JSON.stringify(s));
  for (const l of r.low.slice(0, 8)) console.log("   LOW ", JSON.stringify(l));
  return r;
}

async function main() {
  await mkdir(output, { recursive: true });
  const sid = mock ? mockSessionId : (await (await fetch(base + "/api/sessions")).json()).sessions[0].id;
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  if (mock) await installUiMock(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });

  // Guest-facing screens only. /system requires a real allowlisted server session;
  // client mocks cannot authorize its server component. Role boundaries are checked separately.
  const pages: [string, string][] = [["overview", "/"], ["campaigns", "/campaigns"], ["worlds", "/worlds"], ["characters", "/characters"], ["memory", "/memory"], ["journal", "/journal"], ["settings", "/settings"], ["blueprint", "/blueprint"], ["play", `/play/${sid}`]];
  let totalSmall = 0, totalLow = 0, anyOverflow = false;
  for (const [name, path] of pages) {
    const r = await audit(page, name, path, 1440);
    totalSmall += r.small.length; totalLow += r.low.length; anyOverflow ||= r.overflow;
    await page.screenshot({ path: `${output}/ui-${name}.png`, fullPage: name !== "play" });
  }
  // Every reading preference must hold the same contrast floor.
  for (const theme of ["sepia", "contrast"]) {
    for (const [name, path] of [["overview", "/"], ["play", `/play/${sid}`], ["settings", "/settings"]] as [string, string][]) {
      const r = await audit(page, `${name}:${theme}`, path, 1440, theme);
      totalSmall += r.small.length; totalLow += r.low.length; anyOverflow ||= r.overflow;
    }
  }
  const large = await audit(page, "play:large-text", `/play/${sid}`, 1440, "midnight", "large");
  totalSmall += large.small.length; totalLow += large.low.length; anyOverflow ||= large.overflow;

  // Mobile sweep
  for (const [name, path] of [["overview", "/"], ["play", `/play/${sid}`], ["settings", "/settings"]] as [string, string][]) {
    const r = await audit(page, name + "-mobile", path, 390);
    totalSmall += r.small.length; totalLow += r.low.length; anyOverflow ||= r.overflow;
    await page.screenshot({ path: `${output}/ui-${name}-mobile.png`, fullPage: true });
  }
  await browser.close();
  console.log(`\n═══ TOTAL  tiny:${totalSmall}  lowContrast:${totalLow}  overflow:${anyOverflow}  pageErrors:${errors.length}`);
  if (errors.length) console.log(errors.slice(0, 6));
  if (totalSmall || totalLow || anyOverflow || errors.length) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exit(1); });

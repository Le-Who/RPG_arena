// DS-2: WCAG 2.x contrast for the living token catalog. Pure; colours arrive as sRGB 0–255.
export type Rgb = { r: number; g: number; b: number; a?: number };

function channel(value: number): number {
  const c = Math.min(255, Math.max(0, value)) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Alpha-composite `top` over an opaque `bottom`. */
export function composite(top: Rgb, bottom: Rgb): Rgb {
  const a = top.a ?? 1;
  return { r: top.r * a + bottom.r * (1 - a), g: top.g * a + bottom.g * (1 - a), b: top.b * a + bottom.b * (1 - a) };
}

export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const fg = composite(foreground, background);
  const [light, dark] = [relativeLuminance(fg), relativeLuminance(background)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

export type ContrastGrade = "AAA" | "AA" | "AA-large" | "fail";
export function gradeContrast(ratio: number): ContrastGrade {
  return ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA-large" : "fail";
}

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` (canvas-normalised forms). */
export function parseColor(input: string): Rgb | null {
  const value = input.trim().toLowerCase();
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map(c => c + c).join("") : hex[1];
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha };
  }
  return null;
}

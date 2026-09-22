import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export type DocumentationCheck = { filesChecked: number; linksChecked: number; errors: string[] };

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function markdownFiles(directory: string): Promise<string[]> {
  if (!await exists(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.map(entry => entry.isDirectory()
    ? markdownFiles(join(directory, entry.name))
    : Promise.resolve(entry.name.endsWith(".md") ? [join(directory, entry.name)] : [])));
  return groups.flat().sort();
}

/** Local validation only: never follows remote links or executes documented commands. */
export async function checkDocumentation(root: string): Promise<DocumentationCheck> {
  root = resolve(root);
  const result: DocumentationCheck = { filesChecked: 0, linksChecked: 0, errors: [] };
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const files = [join(root, "README.md"), ...await markdownFiles(join(root, "docs"))];
  for (const file of files) {
    const label = relative(root, file).replaceAll("\\", "/");
    if (!await exists(file)) { result.errors.push(`${label}: document missing`); continue; }
    result.filesChecked++;
    const source = await readFile(file, "utf8");
    // Examples inside fenced blocks aren't claims that a local link target exists.
    const prose = source.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
    for (const match of prose.matchAll(/!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g)) {
      const target = match[1] ?? match[2];
      if (/^(?:[a-z][a-z\d+.-]*:|#|\/)/i.test(target)) continue;
      let local: string;
      try { local = decodeURIComponent(target.split(/[?#]/)[0]); }
      catch { result.errors.push(`${label}: invalid link encoding: ${target}`); continue; }
      if (!local) continue;
      result.linksChecked++;
      if (!await exists(resolve(dirname(file), local))) result.errors.push(`${label}: missing link target: ${target}`);
    }
    // Historical plans/evaluation reports may document commands valid at that time.
    if (label === "README.md" || /^docs\/[^/]*-operations\.md$/.test(label)) {
      const commands = new Set([...source.matchAll(/\bnpm\s+run\s+([a-z\d][a-z\d:_-]*)/gi)].map(match => match[1]));
      for (const name of commands) if (!Object.hasOwn(manifest.scripts ?? {}, name)) result.errors.push(`${label}: missing npm script: ${name}`);
    }
  }

  const journalPath = join(root, "drizzle/meta/_journal.json");
  if (await exists(journalPath)) {
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries?: { idx: number; tag: string; when: number }[] };
    if (!Array.isArray(journal.entries)) result.errors.push("drizzle/meta/_journal.json: entries must be an array");
    else {
      const tags = new Set<string>();
      let previousTimestamp = -Infinity;
      for (const [index, entry] of journal.entries.entries()) {
        if (!entry || typeof entry.tag !== "string" || !/^\d+_[a-z\d_]+$/i.test(entry.tag)) {
          result.errors.push(`Migration entry ${index}: invalid tag`); continue;
        }
        if (entry.idx !== index) result.errors.push(`Migration ${entry.tag}: index must be ${index}`);
        if (tags.has(entry.tag)) result.errors.push(`Duplicate migration tag: ${entry.tag}`);
        tags.add(entry.tag);
        if (!Number.isSafeInteger(entry.when) || entry.when <= previousTimestamp) result.errors.push(`Migration ${entry.tag}: timestamp must be an increasing integer`);
        previousTimestamp = entry.when;
        if (!await exists(join(root, "drizzle", `${entry.tag}.sql`))) result.errors.push(`Missing migration file: ${entry.tag}.sql`);
      }
    }
  }
  return result;
}

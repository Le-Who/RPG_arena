// ── VIS-1 / VIS-2: ручная визуализация сцен, мест и портретов ──
// Общий контракт media provider + первый адаптер (Pollinations). Изображение — иллюстрация,
// а не источник канона: оно никогда не меняет состояние мира. Провайдер не меняется
// незаметно после ошибки: запись хранит provider/model/seed, повтор идёт тем же адаптером.
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions, gameTurns, npcs, sceneObjects, sceneVisuals, visualIdentities, worldLocations, type CharacterState, type VisualKind, type WorldState } from "@/db/schema";
import { HttpError } from "./http";
import { normName } from "./world-life";
import { PROVIDERS, buildVisualPrompt, clip, fetchFromProvider, seedFor, visualConfig } from "./visual-provider";
import { readVisualConfig } from "./visual-settings";
export { buildVisualPrompt, fetchFromProvider, pollinationsProvider, seedFor, styleFor, visualConfig, type MediaProvider, type VisualRequest } from "./visual-provider";

// ─────────────────────────────────────────────────────────────
//  Паспорта внешности (VIS-2)
// ─────────────────────────────────────────────────────────────
type IdentityRow = typeof visualIdentities.$inferSelect;

export async function ensureIdentity(sessionId: string, subjectKey: string, subjectName: string, passport: string): Promise<IdentityRow> {
  const [existing] = await db.select().from(visualIdentities).where(and(eq(visualIdentities.sessionId, sessionId), eq(visualIdentities.subjectKey, subjectKey)));
  if (existing) return existing;
  const [created] = await db.insert(visualIdentities).values({ sessionId, subjectKey, subjectName: clip(subjectName, 120), passport: clip(passport, 600), seed: seedFor(sessionId, subjectKey) })
    .onConflictDoNothing().returning();
  if (created) return created;
  const [raced] = await db.select().from(visualIdentities).where(and(eq(visualIdentities.sessionId, sessionId), eq(visualIdentities.subjectKey, subjectKey)));
  if (!raced) throw new HttpError(409, "IDENTITY_RACE", "Не удалось создать паспорт внешности. Повторите попытку.");
  return raced;
}

export async function updateIdentity(sessionId: string, subjectKey: string, patch: { passport?: string; referenceVisualId?: string | null; reseed?: boolean }) {
  const [identity] = await db.select().from(visualIdentities).where(and(eq(visualIdentities.sessionId, sessionId), eq(visualIdentities.subjectKey, subjectKey)));
  if (!identity) throw new HttpError(404, "NOT_FOUND", "Паспорт внешности не найден.");
  if (patch.referenceVisualId) {
    const [visual] = await db.select({ id: sceneVisuals.id, status: sceneVisuals.status }).from(sceneVisuals).where(and(eq(sceneVisuals.id, patch.referenceVisualId), eq(sceneVisuals.sessionId, sessionId)));
    if (!visual || visual.status !== "ready") throw new HttpError(400, "INVALID_INPUT", "Эталоном можно выбрать только готовое изображение этой истории.");
  }
  const [row] = await db.update(visualIdentities).set({
    ...(patch.passport !== undefined ? { passport: clip(patch.passport, 600) } : {}),
    ...(patch.referenceVisualId !== undefined ? { referenceVisualId: patch.referenceVisualId || null } : {}),
    ...(patch.reseed ? { seed: Math.floor(Math.random() * 2_000_000_000) } : {}),
    updatedAt: new Date(),
  }).where(eq(visualIdentities.id, identity.id)).returning();
  return row;
}

// ─────────────────────────────────────────────────────────────
//  Создание, список, рендер
// ─────────────────────────────────────────────────────────────
const LIST_COLUMNS = {
  id: sceneVisuals.id, kind: sceneVisuals.kind, subjectKey: sceneVisuals.subjectKey, turnNumber: sceneVisuals.turnNumber, caption: sceneVisuals.caption,
  provider: sceneVisuals.provider, model: sceneVisuals.model, seed: sceneVisuals.seed, status: sceneVisuals.status, error: sceneVisuals.error,
  attempts: sceneVisuals.attempts, latencyMs: sceneVisuals.latencyMs, width: sceneVisuals.width, height: sceneVisuals.height, createdAt: sceneVisuals.createdAt,
};
export type VisualView = { id: string; kind: VisualKind; subjectKey: string; turnNumber: number; caption: string; provider: string; model: string; seed: number; status: string; error: string | null; attempts: number; latencyMs: number | null; width: number; height: number; createdAt: Date };

export async function listVisuals(sessionId: string) {
  const [visuals, identities, cfg] = await Promise.all([
    db.select(LIST_COLUMNS).from(sceneVisuals).where(eq(sceneVisuals.sessionId, sessionId)).orderBy(desc(sceneVisuals.createdAt)).limit(60),
    db.select().from(visualIdentities).where(eq(visualIdentities.sessionId, sessionId)),
    readVisualConfig(),
  ]);
  return { visuals: visuals as VisualView[], identities, config: { enabled: cfg.enabled, provider: cfg.provider.id, model: cfg.model, dailyLimit: cfg.dailyLimit, authenticated: cfg.authenticated, capabilities: cfg.provider.capabilities } };
}

function heroPassport(c: CharacterState) {
  return clip([c.appearance, c.archetype].filter(Boolean).join(", "), 500);
}

export async function createVisual(sessionId: string, input: { kind: VisualKind; subject?: string | null; turnNumber?: number | null }) {
  const cfg = await readVisualConfig();
  if (!cfg.enabled) throw new HttpError(503, "VISUALS_DISABLED", "Визуализация отключена администратором.");
  if (!cfg.authenticated) throw new HttpError(503, "VISUAL_PROVIDER_UNCONFIGURED", "Для генерации иллюстраций нужен серверный ключ Pollinations.");
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!session) throw new HttpError(404, "NOT_FOUND", "Кампания не найдена.");
  const world = session.worldState as WorldState;
  const character = session.character as CharacterState;
  const { partOfDay, readLife } = await import("./world-life");
  const life = readLife(world);
  const [locs, people, objects] = await Promise.all([
    db.select().from(worldLocations).where(eq(worldLocations.sessionId, sessionId)),
    db.select().from(npcs).where(eq(npcs.sessionId, sessionId)),
    db.select().from(sceneObjects).where(eq(sceneObjects.sessionId, sessionId)),
  ]);
  const here = locs.find((l) => l.current) ?? locs.find((l) => normName(l.name) === normName(world.currentLocation));
  let subjectKey = "scene", subjectName = world.currentLocation, caption = "", turnNumber = 0, prompt = "", seed = 0, width = 1024, height = 576;

  if (input.kind === "portrait") {
    const subject = input.subject ?? "hero";
    if (subject === "hero") {
      const identity = await ensureIdentity(sessionId, "hero", character.name, heroPassport(character));
      subjectKey = "hero"; subjectName = character.name; seed = identity.seed;
      prompt = buildVisualPrompt({ kind: "portrait", world, subjectName, passport: identity.passport });
    } else {
      const npc = people.find((n) => `npc:${n.key}` === subject || n.key === subject);
      if (!npc) throw new HttpError(404, "NOT_FOUND", "Персонаж не найден.");
      const identity = await ensureIdentity(sessionId, `npc:${npc.key}`, npc.name, clip(`${npc.role}. ${npc.description.replace(/\[ход \d+\][^[]*/g, "")}`, 500));
      subjectKey = identity.subjectKey; subjectName = npc.name; seed = identity.seed;
      prompt = buildVisualPrompt({ kind: "portrait", world, subjectName, passport: identity.passport || npc.role });
    }
    caption = `Портрет: ${subjectName}`; width = 768; height = 960;
  } else if (input.kind === "location") {
    const loc = input.subject ? locs.find((l) => l.id === input.subject || `location:${l.id}` === input.subject) : here;
    if (!loc || !loc.discovered) throw new HttpError(404, "NOT_FOUND", "Место не найдено или ещё не открыто.");
    const identity = await ensureIdentity(sessionId, `location:${loc.id}`, loc.name, loc.description);
    subjectKey = identity.subjectKey; subjectName = loc.name; seed = identity.seed;
    prompt = buildVisualPrompt({ kind: "location", world, subjectName, passport: identity.passport, locationDescription: identity.passport || loc.description, partOfDay: partOfDay(life.clock.minute) });
    caption = `Место: ${loc.name}`;
  } else {
    const turnFilter = input.turnNumber && input.turnNumber > 0 ? and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.role, "narrator"), eq(gameTurns.turnNumber, input.turnNumber)) : and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.role, "narrator"));
    const [turn] = await db.select({ turnNumber: gameTurns.turnNumber, content: gameTurns.content }).from(gameTurns).where(turnFilter).orderBy(desc(gameTurns.turnNumber)).limit(1);
    if (!turn) throw new HttpError(404, "NOT_FOUND", "Нет сцены для иллюстрации.");
    turnNumber = turn.turnNumber;
    const identities = await db.select().from(visualIdentities).where(eq(visualIdentities.sessionId, sessionId));
    const present = people.filter((n) => n.status !== "dead" && (normName(n.lastLocation) === normName(world.currentLocation) || turn.content.includes(n.name)));
    const presentPassports = [{ name: character.name, passport: identities.find((i) => i.subjectKey === "hero")?.passport || heroPassport(character) },
      ...present.map((n) => ({ name: n.name, passport: identities.find((i) => i.subjectKey === `npc:${n.key}`)?.passport || n.role }))];
    const objectNames = objects.filter((o) => normName(o.locationName) === normName(world.currentLocation)).map((o) => `${o.name} (${o.state})`);
    prompt = buildVisualPrompt({ kind: "scene", world, subjectName, passport: "", locationDescription: here?.description, sceneNarration: turn.content, presentPassports, objects: objectNames, partOfDay: partOfDay(life.clock.minute) });
    seed = seedFor(sessionId, `scene:${turn.turnNumber}:${Date.now()}`);
    subjectKey = "scene"; caption = `Сцена хода ${turn.turnNumber} · ${world.currentLocation}`;
  }
  const since = new Date(Date.now() - 24 * 3600_000);
  const quotaScope = session.ownerId ? `owner:${session.ownerId}` : `session:${sessionId}`;
  return await db.transaction(async (tx) => {
    // Serialize the count-and-reserve pair across web instances. Failed and pending rows still consume a reservation.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${quotaScope}))`);
    const [{ used }] = await tx.select({ used: sql<number>`count(*)::int` }).from(sceneVisuals)
      .innerJoin(gameSessions, eq(sceneVisuals.sessionId, gameSessions.id))
      .where(and(session.ownerId ? eq(gameSessions.ownerId, session.ownerId) : eq(sceneVisuals.sessionId, sessionId), gte(sceneVisuals.createdAt, since)));
    if (Number(used ?? 0) >= cfg.dailyLimit) throw new HttpError(429, "VISUAL_QUOTA", `Дневной лимит иллюстраций (${cfg.dailyLimit}) исчерпан. Попробуйте завтра.`, { retryAfter: 3600 });
    const [row] = await tx.insert(sceneVisuals).values({ sessionId, ownerId: session.ownerId, kind: input.kind, subjectKey, turnNumber, caption: clip(caption, 160), prompt, provider: cfg.provider.id, model: cfg.model, seed, width, height }).returning(LIST_COLUMNS);
    return row as VisualView;
  });
}

const inflight = new Map<string, Promise<{ image: Buffer; mimeType: string }>>();

/** Ленивая генерация при первом просмотре: результат сохраняется в БД, повторы идут тем же провайдером/seed. */
export async function renderVisual(sessionId: string, visualId: string, opts: { retry?: boolean; allowGenerate?: boolean } = {}): Promise<{ image: Buffer; mimeType: string }> {
  const [row] = await db.select().from(sceneVisuals).where(and(eq(sceneVisuals.id, visualId), eq(sceneVisuals.sessionId, sessionId)));
  if (!row) throw new HttpError(404, "NOT_FOUND", "Изображение не найдено.");
  if (row.status === "ready" && row.image && row.mimeType) return { image: row.image, mimeType: row.mimeType };
  if (opts.allowGenerate === false) throw new HttpError(403, "VISUAL_NOT_READY", "Эта иллюстрация ещё не готова. Только владелец кампании может запустить генерацию.");
  if (row.status === "failed" && !opts.retry) throw new HttpError(502, "VISUAL_FAILED", row.error ?? "Провайдер не вернул изображение.");
  if (row.attempts >= 4) throw new HttpError(502, "VISUAL_FAILED", "Лимит повторов для этого изображения исчерпан.");
  const provider = PROVIDERS[row.provider];
  if (!provider) throw new HttpError(502, "VISUAL_FAILED", `Провайдер ${row.provider} недоступен.`);
  if (provider.id === "pollinations" && !visualConfig().authenticated) throw new HttpError(503, "VISUAL_PROVIDER_UNCONFIGURED", "Для генерации иллюстраций нужен серверный ключ Pollinations.");
  let job = inflight.get(visualId);
  if (!job) {
    job = (async () => {
      const started = Date.now();
      await db.update(sceneVisuals).set({ attempts: sql`${sceneVisuals.attempts} + 1`, status: "pending", updatedAt: new Date() }).where(and(eq(sceneVisuals.id, visualId), eq(sceneVisuals.sessionId, sessionId)));
      try {
        const result = await fetchFromProvider(provider, { prompt: row.prompt, seed: row.seed, width: row.width, height: row.height, model: row.model });
        await db.update(sceneVisuals).set({ status: "ready", image: result.image, mimeType: result.mimeType, error: null, latencyMs: Date.now() - started, updatedAt: new Date() }).where(and(eq(sceneVisuals.id, visualId), eq(sceneVisuals.sessionId, sessionId)));
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 160) : "PROVIDER_ERROR";
        await db.update(sceneVisuals).set({ status: "failed", error: message, latencyMs: Date.now() - started, updatedAt: new Date() }).where(and(eq(sceneVisuals.id, visualId), eq(sceneVisuals.sessionId, sessionId)));
        throw new HttpError(502, "VISUAL_FAILED", `Провайдер не вернул изображение (${message}).`);
      }
    })().finally(() => inflight.delete(visualId));
    inflight.set(visualId, job);
  }
  return job;
}

export async function deleteVisual(sessionId: string, visualId: string) {
  await db.update(visualIdentities).set({ referenceVisualId: null }).where(and(eq(visualIdentities.sessionId, sessionId), eq(visualIdentities.referenceVisualId, visualId)));
  const deleted = await db.delete(sceneVisuals).where(and(eq(sceneVisuals.id, visualId), eq(sceneVisuals.sessionId, sessionId))).returning({ id: sceneVisuals.id });
  if (!deleted.length) throw new HttpError(404, "NOT_FOUND", "Изображение не найдено.");
}

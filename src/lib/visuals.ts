// ── VIS-1 / VIS-2: ручная визуализация сцен, мест и портретов ──
// Общий контракт media provider + первый адаптер (Pollinations). Изображение — иллюстрация,
// а не источник канона: оно никогда не меняет состояние мира. Провайдер не меняется
// незаметно после ошибки: запись хранит provider/model/seed, повтор идёт тем же адаптером.
import { and, desc, eq, gte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions, gameTurns, npcs, sceneObjects, sceneVisuals, visualIdentities, visualQuotaReservations, worldLocations, type CharacterState, type VisualKind, type WorldState } from "@/db/schema";
import { HttpError } from "./http";
import { OPENAI_VISUAL_ERRORS, visualErrorMessage } from "./visual-errors";
import { normName } from "./world-life";
import { PROVIDERS, buildVisualPrompt, clip, fetchFromProvider, normalizeOpenAIImageDimensions, seedFor, visualConfig, visualProviderTimeoutMs } from "./visual-provider";
import { assertVisualGenerationSelection, readVisualConfig, visualCredential, type VisualAccountSource } from "./visual-settings";
import type { VisualOutputFormat } from "./visual-provider";

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
  provider: sceneVisuals.provider, accountSource: sceneVisuals.accountSource, model: sceneVisuals.model, endpoint: sceneVisuals.endpoint, outputFormat: sceneVisuals.outputFormat, seed: sceneVisuals.seed, status: sceneVisuals.status, error: sceneVisuals.error,
  attempts: sceneVisuals.attempts, latencyMs: sceneVisuals.latencyMs, width: sceneVisuals.width, height: sceneVisuals.height, createdAt: sceneVisuals.createdAt,
};
export type VisualView = { id: string; kind: VisualKind; subjectKey: string; turnNumber: number; caption: string; provider: string; accountSource: VisualAccountSource; generationBlocked?: boolean; model: string; endpoint: string | null; outputFormat: VisualOutputFormat | null; seed: number; status: string; error: string | null; attempts: number; latencyMs: number | null; width: number; height: number; createdAt: Date };

export async function listVisuals(sessionId: string) {
  const [session] = await db.select({ ownerId: gameSessions.ownerId }).from(gameSessions).where(eq(gameSessions.id, sessionId));
  const [visuals, identities, cfg] = await Promise.all([
    db.select({ ...LIST_COLUMNS, payerOwnerId: sceneVisuals.ownerId }).from(sceneVisuals).where(eq(sceneVisuals.sessionId, sessionId)).orderBy(desc(sceneVisuals.createdAt)).limit(60),
    db.select().from(visualIdentities).where(eq(visualIdentities.sessionId, sessionId)),
    readVisualConfig(session?.ownerId),
  ]);
  // Old rows may contain provider exception text. Gallery data is user-visible, so expose
  // the same safe Russian message as render failures without rewriting historical records.
  return { visuals: visuals.map(({ payerOwnerId, ...visual }) => ({ ...visual, generationBlocked: visual.accountSource === "personal" && payerOwnerId !== session?.ownerId, error: visual.error ? visualErrorMessage(visual.error) : null })) as VisualView[], identities, config: { enabled: cfg.enabled, provider: cfg.provider.id, accountSource: cfg.accountSource, availableAccounts: cfg.availableAccounts, model: cfg.model, endpoint: cfg.endpoint, dailyLimit: cfg.dailyLimit, authenticated: cfg.authenticated, capabilities: cfg.provider.capabilities } };
}

function heroPassport(c: CharacterState) {
  return clip([c.appearance, c.archetype, ...(Array.isArray(c.traits) ? c.traits.slice(0, 2) : [])].filter(Boolean).join(", "), 500);
}

export function parseVisualStyleOverride(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 400) throw new HttpError(400, "INVALID_INPUT", "Стиль иллюстрации должен быть текстом до 400 символов.");
  return value.trim() || undefined;
}

export async function createVisual(sessionId: string, input: { kind: VisualKind; subject?: string | null; turnNumber?: number | null; styleOverride?: string }) {
  const styleOverride = parseVisualStyleOverride(input.styleOverride);
  const [session] = await db.select().from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!session) throw new HttpError(404, "NOT_FOUND", "Кампания не найдена.");
  const cfg = await readVisualConfig(session.ownerId);
  if (!cfg.enabled) throw new HttpError(503, "VISUALS_DISABLED", "Иллюстрации выключены. Включите их в настройках, если хотите добавить изображение.");
  if (!cfg.authenticated) throw new HttpError(503, "VISUAL_PROVIDER_UNCONFIGURED", `Выбранный аккаунт ${cfg.provider.id === "openrouter" ? "OpenRouter" : cfg.provider.id === "openai" ? "OpenAI" : "Pollinations"} недоступен. Проверьте подключение в настройках иллюстраций.`);
  const selection = await assertVisualGenerationSelection(cfg.provider.id, cfg.model, cfg.endpoint);
  const world = session.worldState as WorldState;
  const character = session.character as CharacterState;
  const { partOfDay, readLife } = await import("./world-life");
  const life = readLife(world);
  const turnFilter = input.kind === "scene" && input.turnNumber && input.turnNumber > 0
    ? and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.role, "narrator"), eq(gameTurns.turnNumber, input.turnNumber))
    : and(eq(gameTurns.sessionId, sessionId), eq(gameTurns.role, "narrator"));
  const [locs, people, objects, [turn]] = await Promise.all([
    db.select().from(worldLocations).where(eq(worldLocations.sessionId, sessionId)),
    db.select().from(npcs).where(eq(npcs.sessionId, sessionId)),
    db.select().from(sceneObjects).where(eq(sceneObjects.sessionId, sessionId)),
    db.select({ turnNumber: gameTurns.turnNumber, content: gameTurns.content }).from(gameTurns).where(turnFilter).orderBy(desc(gameTurns.turnNumber)).limit(1),
  ]);
  const here = locs.find((l) => l.current) ?? locs.find((l) => normName(l.name) === normName(world.currentLocation));
  let subjectKey = "scene", subjectName = world.currentLocation, caption = "", turnNumber = 0, prompt = "", seed = 0, width = 1024, height = 576;

  if (input.kind === "portrait") {
    const subject = input.subject ?? "hero";
    if (subject === "hero") {
      const identity = await ensureIdentity(sessionId, "hero", character.name, heroPassport(character));
      subjectKey = "hero"; subjectName = character.name; seed = identity.seed;
      prompt = buildVisualPrompt({ kind: "portrait", world, subjectName, passport: identity.passport, styleOverride, sceneNarration: turn?.content });
    } else {
      const npc = people.find((n) => `npc:${n.key}` === subject || n.key === subject);
      if (!npc) throw new HttpError(404, "NOT_FOUND", "Персонаж не найден.");
      const identity = await ensureIdentity(sessionId, `npc:${npc.key}`, npc.name, clip(`${npc.role}. ${npc.description.replace(/\[ход \d+\][^[]*/g, "")}`, 500));
      subjectKey = identity.subjectKey; subjectName = npc.name; seed = identity.seed;
      const inCurrentScene = Boolean(npc.lastLocation && normName(npc.lastLocation) === normName(world.currentLocation) && turn?.content.includes(npc.name));
      prompt = buildVisualPrompt({ kind: "portrait", world: { ...world, currentLocation: npc.lastLocation }, subjectName, passport: identity.passport || npc.role, styleOverride, sceneNarration: inCurrentScene ? turn?.content : undefined });
    }
    caption = `Портрет: ${subjectName}`; width = 768; height = 960;
  } else if (input.kind === "location") {
    const loc = input.subject ? locs.find((l) => l.id === input.subject || `location:${l.id}` === input.subject) : here;
    if (!loc || !loc.discovered) throw new HttpError(404, "NOT_FOUND", "Место не найдено или ещё не открыто.");
    const identity = await ensureIdentity(sessionId, `location:${loc.id}`, loc.name, loc.description);
    subjectKey = identity.subjectKey; subjectName = loc.name; seed = identity.seed;
    prompt = buildVisualPrompt({ kind: "location", world: { ...world, currentLocation: loc.name }, subjectName, passport: identity.passport, locationDescription: identity.passport || loc.description, partOfDay: partOfDay(life.clock.minute), styleOverride, sceneNarration: normName(loc.name) === normName(world.currentLocation) ? turn?.content : undefined });
    caption = `Место: ${loc.name}`;
  } else {
    if (!turn) throw new HttpError(404, "NOT_FOUND", "Нет сцены для иллюстрации.");
    turnNumber = turn.turnNumber;
    const identities = await db.select().from(visualIdentities).where(eq(visualIdentities.sessionId, sessionId));
    const present = people.filter((n) => n.status !== "dead" && (normName(n.lastLocation) === normName(world.currentLocation) || turn.content.includes(n.name)));
    const presentPassports = [{ name: character.name, passport: identities.find((i) => i.subjectKey === "hero")?.passport || heroPassport(character) },
      ...present.map((n) => ({ name: n.name, passport: identities.find((i) => i.subjectKey === `npc:${n.key}`)?.passport || n.role }))];
    const objectNames = objects.filter((o) => normName(o.locationName) === normName(world.currentLocation)).map((o) => `${o.name} (${o.state})`);
    prompt = buildVisualPrompt({ kind: "scene", world, subjectName, passport: "", locationDescription: here?.description, sceneNarration: turn.content, presentPassports, objects: objectNames, partOfDay: partOfDay(life.clock.minute), styleOverride });
    seed = seedFor(sessionId, `scene:${turn.turnNumber}:${Date.now()}`);
    subjectKey = "scene"; caption = `Сцена хода ${turn.turnNumber} · ${world.currentLocation}`;
  }
  if (cfg.provider.id === "openai") ({ width, height } = normalizeOpenAIImageDimensions(width, height));
  const since = new Date(Date.now() - 24 * 3600_000);
  const quotaScope = session.ownerId ? `owner:${session.ownerId}` : `session:${sessionId}`;
  return await db.transaction(async (tx) => {
    // Serialize the count-and-reserve pair across web instances. Failed and pending rows still consume a reservation.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${quotaScope}))`);
    // Guest adoption retains reservation provenance while charging the account's ancestry.
    const scope = session.ownerId ? or(eq(visualQuotaReservations.quotaScope, quotaScope), sql`${visualQuotaReservations.quotaScope} IN (
      SELECT 'owner:' || consumed.profile_id FROM consumed_guest_profiles consumed
      JOIN accounts account ON account.id = consumed.account_id WHERE account.profile_id = ${session.ownerId}
    )`) : eq(visualQuotaReservations.quotaScope, quotaScope);
    const [{ used }] = await tx.select({ used: sql<number>`count(*)::int` }).from(visualQuotaReservations)
      .where(and(scope, gte(visualQuotaReservations.createdAt, since)));
    if (Number(used ?? 0) >= cfg.dailyLimit) throw new HttpError(429, "VISUAL_QUOTA", `Дневной лимит иллюстраций (${cfg.dailyLimit}) исчерпан. Попробуйте завтра.`, { retryAfter: 3600 });
    const [row] = await tx.insert(sceneVisuals).values({ sessionId, ownerId: session.ownerId, kind: input.kind, subjectKey, turnNumber, caption: clip(caption, 160), prompt, provider: cfg.provider.id, accountSource: cfg.accountSource, model: cfg.model, endpoint: cfg.endpoint, outputFormat: selection.outputFormat, seed, width, height }).returning(LIST_COLUMNS);
    await tx.insert(visualQuotaReservations).values({ quotaScope, visualId: row.id });
    return row as VisualView;
  });
}

const inflight = new Map<string, Promise<{ image: Buffer; mimeType: string }>>();
const visualWaitMs = 95_000;
const visualErrorCodes = new Set(["PROVIDER_ERROR", "PROVIDER_TIMEOUT", "PROVIDER_NOT_IMAGE", "PROVIDER_BAD_SIZE", "POLLINATIONS_KEY_REQUIRED", ...Object.keys(OPENAI_VISUAL_ERRORS)]);
function safeVisualError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return visualErrorCodes.has(message) || /^PROVIDER_HTTP_[45]\d{2}$/.test(message) ? message : "PROVIDER_ERROR";
}

/** Ленивая генерация при первом просмотре: результат сохраняется в БД, повторы идут тем же провайдером/seed. */
export async function renderVisual(sessionId: string, visualId: string, opts: { retry?: boolean; allowGenerate?: boolean; beforeSpend?: () => Promise<void> } = {}): Promise<{ image: Buffer; mimeType: string }> {
  const [row] = await db.select().from(sceneVisuals).where(and(eq(sceneVisuals.id, visualId), eq(sceneVisuals.sessionId, sessionId)));
  if (!row) throw new HttpError(404, "NOT_FOUND", "Изображение не найдено.");
  if (row.status === "ready" && row.image && row.mimeType) return { image: row.image, mimeType: row.mimeType };
  if (opts.allowGenerate === false) throw new HttpError(403, "VISUAL_NOT_READY", "Эта иллюстрация ещё не готова. Только владелец кампании может запустить генерацию.");
  const config = visualConfig();
  if (!config.enabled) throw new HttpError(503, "VISUALS_DISABLED", "Визуализация отключена администратором.");
  if (row.status === "failed" && !opts.retry) throw new HttpError(502, "VISUAL_FAILED", visualErrorMessage(row.error));
  const provider = PROVIDERS[row.provider];
  const visualLeaseMs = visualProviderTimeoutMs(row.provider) + 15_000; // Leave time for persistence after provider IO.
  if (!provider) throw new HttpError(502, "VISUAL_FAILED", `Провайдер ${row.provider} недоступен.`);
  const [session] = await db.select({ ownerId: gameSessions.ownerId }).from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (row.accountSource === "personal" && row.ownerId !== session?.ownerId) throw new HttpError(409, "VISUAL_PAYER_CHANGED", "Владелец этой иллюстрации изменился. Создайте новую иллюстрацию с выбранным аккаунтом.");
  await assertVisualGenerationSelection(row.provider, row.model, row.endpoint);
  let job = inflight.get(visualId);
  if (!job) {
    job = (async () => {
      const waitUntil = Date.now() + visualWaitMs;
      let claimed: typeof row;
      let apiKey: string;
      while (true) {
        const [current] = await db.select().from(sceneVisuals).where(and(eq(sceneVisuals.id, visualId), eq(sceneVisuals.sessionId, sessionId)));
        if (!current) throw new HttpError(404, "NOT_FOUND", "Изображение не найдено.");
        if (current.status === "ready" && current.image && current.mimeType) return { image: current.image, mimeType: current.mimeType };
        // A committed attempt is a bounded lease shared by all web instances.
        // Neither a connection nor a transaction remains open during provider IO.
        if (current.status === "pending" && current.attempts > 0 && current.updatedAt.getTime() + visualLeaseMs > Date.now()) {
          if (Date.now() >= waitUntil) throw new HttpError(503, "VISUAL_BUSY", "Изображение ещё создаётся. Повторите просмотр позже.", { retryAfter: 1 });
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        if (current.status === "failed" && !opts.retry) throw new HttpError(502, "VISUAL_FAILED", visualErrorMessage(current.error));
        if (current.attempts >= 4) throw new HttpError(502, "VISUAL_FAILED", "Лимит повторов для этого изображения исчерпан.");
        // The HTTP caller owns request identity. Revalidate it after catalogue IO and lease waits,
        // before resolving credentials or claiming an attempt; pure library callers need no request context.
        await opts.beforeSpend?.();
        // Resolve the payer and current shared credential after catalogue IO and any lease wait.
        // A removed/rotated key must not remain captured while a queued request waits to spend it.
        const [payerSession] = await db.select({ ownerId: gameSessions.ownerId }).from(gameSessions).where(eq(gameSessions.id, sessionId));
        if (current.accountSource === "personal" && current.ownerId !== payerSession?.ownerId) throw new HttpError(409, "VISUAL_PAYER_CHANGED", "Владелец этой иллюстрации изменился. Создайте новую иллюстрацию с выбранным аккаунтом.");
        apiKey = await visualCredential(payerSession?.ownerId ?? null, current.accountSource, current.provider);
        // The attempt counter is monotonic, so CAS both reserves and fences work.
        const [reservation] = await db.update(sceneVisuals).set({ attempts: current.attempts + 1, status: "pending", updatedAt: new Date() })
          .where(and(eq(sceneVisuals.id, visualId), eq(sceneVisuals.sessionId, sessionId), eq(sceneVisuals.attempts, current.attempts), eq(sceneVisuals.status, current.status))).returning();
        if (reservation) { claimed = reservation; break; }
      }
      const started = Date.now();
      const fence = and(eq(sceneVisuals.id, visualId), eq(sceneVisuals.sessionId, sessionId), eq(sceneVisuals.attempts, claimed.attempts), eq(sceneVisuals.status, "pending"));
      try {
        const result = await fetchFromProvider(provider, { prompt: claimed.prompt, seed: claimed.seed, width: claimed.width, height: claimed.height, model: claimed.model, endpoint: claimed.endpoint, outputFormat: claimed.outputFormat }, fetch, apiKey);
        await db.update(sceneVisuals).set({ status: "ready", image: result.image, mimeType: result.mimeType, error: null, latencyMs: Date.now() - started, updatedAt: new Date() }).where(fence);
        return result;
      } catch (error) {
        const message = safeVisualError(error);
        await db.update(sceneVisuals).set({ status: "failed", error: message, latencyMs: Date.now() - started, updatedAt: new Date() }).where(fence);
        throw new HttpError(502, "VISUAL_FAILED", visualErrorMessage(message));
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

import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { MODEL_CATALOG, ROUTING_PROFILES, RoutingProfile, envKeys } from "@/lib/gemini";
import { getSettingsRow } from "@/lib/ai-settings";
import { EMBEDDING_MODEL_ALIASES } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

const MAX_KEYS = 10;
const KNOWN_MODELS = new Set<string>(MODEL_CATALOG.map((m) => m.id));

function mask(keys: string[]) {
  return keys.map((k) => (k.length <= 8 ? "••••" : `${k.slice(0, 4)}••••${k.slice(-4)}`));
}

function view(s: Awaited<ReturnType<typeof getSettingsRow>>) {
  const keys = ((s.keys as string[]) ?? []).filter(Boolean);
  return {
    keysMasked: mask(keys),
    keysCount: keys.length,
    envKeysCount: envKeys().length,
    routingProfile: s.routingProfile ?? "balanced",
    narrationModel: s.narrationModel,
    customActionModel: s.customActionModel,
    compactionModel: s.compactionModel,
    fastTaskModel: s.fastTaskModel,
    primaryModel: s.primaryModel ?? s.narrationModel,
    fallbackChain: s.fallbackChain,
    useLiveAI: s.useLiveAI,
    dailyFlashLimit: s.dailyFlashLimit,
    dailyLiteLimit: s.dailyLiteLimit,
    enforceLimits: s.enforceLimits,
    embeddingsEnabled: s.embeddingsEnabled,
    embeddingModel: s.embeddingModel,
    embeddingDims: s.embeddingDims,
    semanticExtractionEnabled: s.semanticExtractionEnabled,
    embeddingModels: EMBEDDING_MODEL_ALIASES,
    profiles: ROUTING_PROFILES,
  };
}

export async function GET() {
  try {
    return NextResponse.json(view(await getSettingsRow()));
  } catch (err) {
    console.error("[settings GET]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const s = await getSettingsRow();
    const currentKeys = ((s.keys as string[]) ?? []).filter(Boolean);

    let keys = currentKeys;
    if (typeof body.keysText === "string") {
      const parsed = body.keysText.split(/[\n,;\s]+/).map((k: string) => k.trim()).filter((k: string) => k.length > 10);
      keys = body.append === false ? parsed : [...new Set([...currentKeys, ...parsed])];
    }
    if (Array.isArray(body.removeIndex)) keys = keys.filter((_, i) => !body.removeIndex.includes(i));
    if (body.clearKeys === true) keys = [];
    keys = keys.slice(0, MAX_KEYS); // DATA-1d: лимит ключей во всех путях

    const profile: RoutingProfile = ROUTING_PROFILES[body.routingProfile as RoutingProfile] ? body.routingProfile : ((s.routingProfile as RoutingProfile) ?? "balanced");
    const pickModel = (v: unknown, cur: string) => (typeof v === "string" && KNOWN_MODELS.has(v) ? v : cur);
    let narrationModel = pickModel(body.narrationModel, s.narrationModel);
    let customActionModel = pickModel(body.customActionModel, s.customActionModel);
    let compactionModel = pickModel(body.compactionModel, s.compactionModel);
    let fastTaskModel = pickModel(body.fastTaskModel, s.fastTaskModel);
    if (body.routingProfile && profile !== "custom") {
      const pConf = ROUTING_PROFILES[profile].config;
      narrationModel = pConf.narrationModel;
      customActionModel = pConf.customActionModel;
      compactionModel = pConf.compactionModel;
      fastTaskModel = pConf.fastTaskModel;
    }
    const intIn = (v: unknown, lo: number, hi: number, cur: number) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Math.max(lo, Math.min(hi, Math.round(Number(v)))) : cur);
    const boolIn = (v: unknown, cur: boolean) => (typeof v === "boolean" ? v : cur);
    const embeddingDims = intIn(body.embeddingDims, 128, 3072, s.embeddingDims);
    const embeddingModel = typeof body.embeddingModel === "string" && /^gemini-embedding-/.test(body.embeddingModel) ? body.embeddingModel.slice(0, 60) : s.embeddingModel;

    await db
      .update(aiSettings)
      .set({
        keys,
        routingProfile: profile,
        narrationModel,
        customActionModel,
        compactionModel,
        fastTaskModel,
        primaryModel: narrationModel,
        useLiveAI: boolInAuto(body.useLiveAI, s.useLiveAI, keys.length + envKeys().length),
        dailyFlashLimit: intIn(body.dailyFlashLimit, 1, 100000, s.dailyFlashLimit),
        dailyLiteLimit: intIn(body.dailyLiteLimit, 1, 1000000, s.dailyLiteLimit),
        enforceLimits: boolIn(body.enforceLimits, s.enforceLimits),
        embeddingsEnabled: boolIn(body.embeddingsEnabled, s.embeddingsEnabled),
        embeddingModel,
        embeddingDims,
        semanticExtractionEnabled: boolIn(body.semanticExtractionEnabled, s.semanticExtractionEnabled),
        updatedAt: new Date(),
      })
      .where(eq(aiSettings.id, "global"));

    const fresh = await getSettingsRow();
    return NextResponse.json({ ok: true, ...view(fresh) });
  } catch (err) {
    console.error("[settings POST]", err);
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

/** Live нельзя включить без ключей; при удалении всех ключей — выключаем автоматически. */
function boolInAuto(v: unknown, cur: boolean, totalKeys: number) {
  const next = typeof v === "boolean" ? v : cur;
  return totalKeys > 0 ? next : false;
}

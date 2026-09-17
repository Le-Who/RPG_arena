import { NextResponse } from "next/server";
import { db } from "@/db";
import { aiSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ROUTING_PROFILES, RoutingProfile } from "@/lib/gemini";

export const dynamic = "force-dynamic";

async function getSettings() {
  const rows = await db.select().from(aiSettings).where(eq(aiSettings.id, "global"));
  if (rows[0]) return rows[0];
  await db.insert(aiSettings).values({
    id: "global",
    keys: [],
    useLiveAI: false,
    routingProfile: "balanced",
    narrationModel: "gemini-3.5-flash-lite",
    customActionModel: "gemini-3.8-flash",
    compactionModel: "gemini-3.8-flash",
    fastTaskModel: "gemini-3.5-flash-lite",
  });
  const fresh = await db.select().from(aiSettings).where(eq(aiSettings.id, "global"));
  return fresh[0];
}

function mask(keys: string[]) {
  return keys.map((k) => (k.length <= 8 ? "••••" : `${k.slice(0, 4)}••••${k.slice(-4)}`));
}

export async function GET() {
  try {
    const s = await getSettings();
    return NextResponse.json({
      keysMasked: mask((s.keys as string[]) ?? []),
      keysCount: ((s.keys as string[]) ?? []).length,
      routingProfile: s.routingProfile ?? "balanced",
      narrationModel: s.narrationModel ?? "gemini-3.5-flash-lite",
      customActionModel: s.customActionModel ?? "gemini-3.8-flash",
      compactionModel: s.compactionModel ?? "gemini-3.8-flash",
      fastTaskModel: s.fastTaskModel ?? "gemini-3.5-flash-lite",
      primaryModel: s.primaryModel ?? s.narrationModel ?? "gemini-3.5-flash-lite",
      fallbackChain: s.fallbackChain,
      useLiveAI: s.useLiveAI,
      dailyFlashLimit: s.dailyFlashLimit,
      dailyLiteLimit: s.dailyLiteLimit,
      profiles: ROUTING_PROFILES,
    });
  } catch (err) {
    console.error("[settings GET]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
  const body = await req.json().catch(() => ({}));
  const s = await getSettings();
  const currentKeys = ((s.keys as string[]) ?? []).filter(Boolean);

  let keys = currentKeys;
  if (typeof body.keysText === "string") {
    const parsed = body.keysText
      .split(/[\n,;]+/)
      .map((k: string) => k.trim())
      .filter((k: string) => k.length > 10);
    if (body.append === false) keys = parsed;
    else keys = [...new Set([...currentKeys, ...parsed])].slice(0, 10);
  }
  if (Array.isArray(body.removeIndex)) {
    keys = keys.filter((_, i) => !body.removeIndex.includes(i));
  }
  if (body.clearKeys === true) keys = [];

  let profile = (body.routingProfile as RoutingProfile) ?? s.routingProfile ?? "balanced";
  let narrationModel = body.narrationModel ?? s.narrationModel ?? "gemini-3.5-flash-lite";
  let customActionModel = body.customActionModel ?? s.customActionModel ?? "gemini-3.8-flash";
  let compactionModel = body.compactionModel ?? s.compactionModel ?? "gemini-3.8-flash";
  let fastTaskModel = body.fastTaskModel ?? s.fastTaskModel ?? "gemini-3.5-flash-lite";

  // Если выбран готовый профиль, применить его значения
  if (body.routingProfile && ROUTING_PROFILES[body.routingProfile as RoutingProfile] && body.routingProfile !== "custom") {
    const pConf = ROUTING_PROFILES[body.routingProfile as RoutingProfile].config;
    narrationModel = pConf.narrationModel;
    customActionModel = pConf.customActionModel;
    compactionModel = pConf.compactionModel;
    fastTaskModel = pConf.fastTaskModel;
  }

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
      fallbackChain: body.fallbackChain ?? s.fallbackChain,
      useLiveAI: typeof body.useLiveAI === "boolean" ? body.useLiveAI : s.useLiveAI,
      dailyFlashLimit: body.dailyFlashLimit ?? s.dailyFlashLimit,
      dailyLiteLimit: body.dailyLiteLimit ?? s.dailyLiteLimit,
      updatedAt: new Date(),
    })
    .where(eq(aiSettings.id, "global"));

  return NextResponse.json({
    ok: true,
    keysCount: keys.length,
    keysMasked: mask(keys),
    routingProfile: profile,
    narrationModel,
    customActionModel,
    compactionModel,
    fastTaskModel,
  });
  } catch (err) {
    console.error("[settings POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

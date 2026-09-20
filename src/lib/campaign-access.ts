import { eq } from "drizzle-orm";
import { db } from "@/db";
import { gameSessions } from "@/db/schema";
import { currentProfileId } from "./identity";
import { canAccessCampaign, type CampaignAccess } from "./campaign-policy";
import { HttpError, httpError, requireUuid } from "./http";

export async function sessionOwnerId(sessionId: string): Promise<string> {
  const [session] = await db.select({ ownerId: gameSessions.ownerId }).from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!session?.ownerId) throw new HttpError(404, "NOT_FOUND", "Кампания не найдена.");
  return session.ownerId;
}

export async function requireCampaignAccess(sessionId: string, access: CampaignAccess = "owner") {
  requireUuid(sessionId);
  const profileId = await currentProfileId();
  const [session] = await db.select({ ownerId: gameSessions.ownerId, visibility: gameSessions.visibility }).from(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!session || !canAccessCampaign(session, profileId, access)) throw new HttpError(404, "NOT_FOUND", "Кампания не найдена.");
  return { profileId, isOwner: session.ownerId === profileId };
}

/** Enforce authorization inside route handlers, including nested campaign endpoints. */
export function withCampaignAccess<P extends { id: string }>(access: CampaignAccess, handler: (request: Request, context: { params: Promise<P> }) => Promise<Response>) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    try {
      await requireCampaignAccess((await context.params).id, access);
      const response = await handler(request, context);
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    } catch (error) { return httpError(error); }
  };
}

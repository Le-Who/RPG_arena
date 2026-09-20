import { GUEST_COOKIE, profileIdFromToken } from "./guest-identity";
import { HttpError } from "./http";

export async function currentProfileId(): Promise<string> {
  const { cookies } = await import("next/headers");
  const id = profileIdFromToken((await cookies()).get(GUEST_COOKIE)?.value);
  if (!id) throw new HttpError(401, "IDENTITY_REQUIRED", "Обновите страницу, чтобы открыть гостевой профиль.");
  return id;
}

import { GUEST_COOKIE } from "./guest-identity";
import { SESSION_COOKIE } from "./auth-policy";
import { auth } from "./auth";

export async function currentIdentity() {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  return auth.resolve(jar.get(GUEST_COOKIE)?.value, jar.get(SESSION_COOKIE)?.value);
}
export async function currentProfileId(): Promise<string> { return (await currentIdentity()).profileId; }

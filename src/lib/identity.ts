import { GUEST_COOKIE } from "./guest-identity";
import { SESSION_COOKIE } from "./auth-policy";
import { auth } from "./auth";
import { assertAdmittedIdentity } from "./identity-scope";

export async function currentIdentity() {
  const { cookies } = await import("next/headers");
  const jar = await cookies();
  const identity = await auth.resolve(jar.get(GUEST_COOKIE)?.value, jar.get(SESSION_COOKIE)?.value);
  assertAdmittedIdentity(identity);
  return identity;
}
export async function currentProfileId(): Promise<string> { return (await currentIdentity()).profileId; }

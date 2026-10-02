import { randomUUID } from "node:crypto";
import { pool } from "@/db";
import { newGuestToken, profileIdFromToken } from "./guest-identity";
import { hashPassword, isAdminAccount, newSessionToken, normalizeLogin, SESSION_MAX_AGE, tokenHash, validSessionToken, verifyPassword } from "./auth-policy";
import { HttpError } from "./http";

export type AuthQuery = { query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };
export type AuthDatabase = AuthQuery & { transaction<T>(run: (tx: AuthQuery) => Promise<T>): Promise<T> };
export type Account = { id: string; login: string; profileId: string };
export type Identity = { kind: "account" | "guest"; profileId: string; account: Account | null; guestProfileId: string | null; isAdmin: boolean };
type AccountRow = { id: string; login: string; profile_id: string; password_hash: string };
const denied = () => new HttpError(401, "IDENTITY_REQUIRED", "IDENTITY_REQUIRED: обновите страницу для нового гостевого профиля.");
const invalid = () => new HttpError(401, "INVALID_CREDENTIALS", "INVALID_CREDENTIALS: неверный логин или пароль.");
export const OWNER_LOCK_NAMESPACE = 9143;
export async function lockGuestClaim(tx: AuthQuery, profileId: string) {
  const { rows } = await tx.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS locked", [OWNER_LOCK_NAMESPACE, profileId]);
  if (!rows[0]?.locked) throw new HttpError(409, "OWNER_BUSY", "OWNER_BUSY: дождитесь завершения работы с историями и повторите перенос.");
  const active = await tx.query("SELECT 1 FROM owner_activity WHERE owner_id=$1 LIMIT 1", [profileId]);
  if (active.rows.length) throw new HttpError(409, "OWNER_BUSY", "OWNER_BUSY: дождитесь завершения работы с историями и повторите перенос.");
}
export const authDatabase: AuthDatabase = {
  query: (sql, values) => pool.query(sql, values),
  async transaction(run) {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  },
};
export function createAuthService(database: AuthDatabase) {
  async function guestProfile(token?: string, tx: AuthQuery = database) {
    const id = profileIdFromToken(token);
    if (!id) return null;
    const { rows } = await tx.query("SELECT 1 FROM consumed_guest_profiles WHERE profile_id=$1", [id]);
    return rows.length ? null : id;
  }
  async function accountForToken(token?: string, tx: AuthQuery = database): Promise<AccountRow | null> {
    if (!validSessionToken(token)) return null;
    const { rows } = await tx.query<AccountRow>("SELECT a.* FROM accounts a JOIN account_sessions s ON s.account_id=a.id WHERE s.token_hash=$1 AND s.expires_at > now()", [tokenHash(token)]);
    return rows[0] ?? null;
  }
  async function resolve(guestToken?: string, sessionToken?: string): Promise<Identity> {
    const row = await accountForToken(sessionToken);
    const guestProfileId = await guestProfile(guestToken);
    if (row) return { kind: "account", profileId: row.profile_id, account: { id: row.id, login: row.login, profileId: row.profile_id }, guestProfileId, isAdmin: isAdminAccount(row.id) };
    if (!guestProfileId) throw denied();
    return { kind: "guest", profileId: guestProfileId, account: null, guestProfileId, isAdmin: false };
  }
  async function requireAccount(token: string, tx: AuthQuery) {
    const row = await accountForToken(token, tx);
    if (!row) throw denied();
    await tx.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [row.id]);
    // A logout/password operation may have won while the account row was locked.
    const current = await accountForToken(token, tx);
    if (!current) throw denied();
    return current;
  }
  async function issueSession(tx: AuthQuery, id: string) {
    const token = newSessionToken();
    await tx.query("INSERT INTO account_sessions(token_hash,account_id,expires_at) VALUES ($1,$2,now() + $3 * interval '1 second')", [tokenHash(token), id, SESSION_MAX_AGE]);
    return token;
  }
  async function claim(tx: AuthQuery, guestToken: string, accountId: string) {
    const profile = profileIdFromToken(guestToken);
    if (!profile) throw denied();
    await lockGuestClaim(tx, profile);
    if (!await guestProfile(guestToken, tx)) throw new HttpError(409, "GUEST_CONSUMED", "GUEST_CONSUMED");
    await tx.query("INSERT INTO consumed_guest_profiles(profile_id,account_id) VALUES ($1,$2)", [profile, accountId]);
    return profile;
  }
  return {
    guestProfile, resolve,
    async view(guestToken?: string, sessionToken?: string) {
      const identity = await resolve(guestToken, sessionToken);
      const { rows } = identity.kind === "account" && identity.guestProfileId
        ? await database.query<{ n: number }>("SELECT count(*)::int AS n FROM game_sessions WHERE owner_id=$1", [identity.guestProfileId]) : { rows: [{ n: 0 }] };
      return { ...identity, pendingGuestCampaigns: rows[0].n, capabilities: { administration: identity.isAdmin }, passwordRecoveryAvailable: false };
    },
    async register(guestToken: string, loginInput: unknown, password: string) {
      const login = normalizeLogin(loginInput), passwordHash = await hashPassword(password);
      const profile = profileIdFromToken(guestToken);
      if (!profile) throw denied();
      const id = randomUUID();
      const sessionToken = await database.transaction(async tx => {
        await lockGuestClaim(tx, profile);
        if (!await guestProfile(guestToken, tx)) throw new HttpError(409, "GUEST_CONSUMED", "GUEST_CONSUMED");
        const inserted = await tx.query("INSERT INTO accounts(id,login,profile_id,password_hash) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id", [id, login, profile, passwordHash]);
        if (!inserted.rows.length) throw new HttpError(409, "REGISTRATION_UNAVAILABLE", "Не удалось зарегистрировать этот логин.");
        await claim(tx, guestToken, id);
        return issueSession(tx, id);
      });
      const freshGuest = newGuestToken();
      return { sessionToken, guestToken: freshGuest, identity: await resolve(freshGuest, sessionToken) };
    },
    async login(guestToken: string, loginInput: unknown, password: unknown) {
      let login: string;
      try { login = normalizeLogin(loginInput); } catch { await verifyPassword(password); throw invalid(); }
      const { rows } = await database.query<AccountRow>("SELECT * FROM accounts WHERE login=$1", [login]);
      const row = rows[0];
      if (!await verifyPassword(password, row?.password_hash)) throw invalid();
      const sessionToken = await database.transaction(async tx => {
        const current = await tx.query<AccountRow>("SELECT * FROM accounts WHERE id=$1 FOR UPDATE", [row.id]);
        if (current.rows[0]?.password_hash !== row.password_hash) throw invalid();
        return issueSession(tx, row.id);
      });
      const usableGuest = await guestProfile(guestToken) ? guestToken : newGuestToken();
      return { sessionToken, guestToken: usableGuest, identity: await resolve(usableGuest, sessionToken) };
    },
    async logout(token?: string) {
      if (validSessionToken(token)) await database.query("DELETE FROM account_sessions WHERE token_hash=$1", [tokenHash(token)]);
    },
    async logoutAll(token: string) {
      await database.transaction(async tx => { const row = await requireAccount(token, tx); await tx.query("DELETE FROM account_sessions WHERE account_id=$1", [row.id]); });
    },
    async changePassword(token: string, oldPassword: unknown, newPassword: string) {
      const passwordHash = await hashPassword(newPassword);
      await database.transaction(async tx => {
        const row = await requireAccount(token, tx);
        if (!await verifyPassword(oldPassword, row.password_hash)) throw invalid();
        await tx.query("UPDATE accounts SET password_hash=$1 WHERE id=$2", [passwordHash, row.id]);
        await tx.query("DELETE FROM account_sessions WHERE account_id=$1", [row.id]);
      });
    },
    async adopt(guestToken: string, token: string) {
      await database.transaction(async tx => {
        const account = await requireAccount(token, tx);
        const profile = await claim(tx, guestToken, account.id);
        // Campaign data follows its session. Personal settings/keys remain untouched (owner-bound AAD).
        await tx.query("UPDATE game_sessions SET owner_id=$1 WHERE owner_id=$2", [account.profile_id, profile]);
      });
      const freshGuest = newGuestToken();
      return { guestToken: freshGuest, identity: await resolve(freshGuest, token) };
    },
    async rateLimit(action: string, client: string) {
      const limit = action === "register" ? 10 : 30;
      const { rows } = await database.query<{ attempts: number }>(`INSERT INTO auth_rate_limits(bucket,attempts,expires_at) VALUES ($1,1,now()+interval '15 minutes')
        ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE auth_rate_limits.attempts+1 END,
        expires_at=CASE WHEN auth_rate_limits.expires_at <= now() THEN now()+interval '15 minutes' ELSE auth_rate_limits.expires_at END RETURNING attempts`, [`${action}:${client}`]);
      if (rows[0].attempts > limit) throw new HttpError(429, "RATE_LIMITED", "RATE_LIMITED: повторите позже.", { retryAfter: 900 });
    },
  };
}
export const auth = createAuthService(authDatabase);

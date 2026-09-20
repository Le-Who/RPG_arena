# Profiles, campaign privacy and migration

The website previously used one `ai_settings.global` row and one `workspace_preferences.local` row; campaigns had no owner. Migration `0005_user_isolation` introduces ownership without deleting existing data.

## Deploy

1. Back up PostgreSQL using the deployment's normal backup procedure.
2. Apply migrations before starting the new application: `npm run migrate` with the deployment's `DATABASE_URL`.
3. Deploy the application and memory worker together. Do not leave the previous worker running: it uses global credentials.
4. Each browser receives a random 256-bit HttpOnly, SameSite=Lax cookie, Secure on HTTPS. The profile identifier is a SHA-256 digest, not the credential. It is safe to reference that identifier for an administrator-assisted import. Use HTTPS in deployment.

The cookie lasts one year. Guest access belongs to that browser profile; clearing cookies, using another browser or expiry creates a new guest. There is no login/account recovery or cross-device identity in this version. Settings explain this limitation. Users in the same browser profile share that guest identity.

Gemini and TypeSafe keys entered on the website belong only to that profile. Website requests and workers never fall back to environment keys. Environment keys remain available only to standalone evaluation scripts that explicitly support them. No API returns full stored credentials.

## Existing data

Existing campaigns have a null owner and remain private and inaccessible over HTTP. Old `global` and `local` rows remain intact. Never automatically assign them to the first visitor: that would expose private stories and credentials.

An administrator can assign selected old campaigns to a known browser profile using the offline script. Obtain the intended browser's `id` from `/api/workspace` (browser developer tools, Network). Do not copy or share its cookie.

```powershell
# Dry run; repeat --campaign for additional explicitly selected campaigns.
node --env-file=.env --import tsx scripts/assign-legacy-profile.ts --profile=guest:<digest> --campaign=<uuid>

# Apply the reviewed selection. Campaigns become private under that profile.
node --env-file=.env --import tsx scripts/assign-legacy-profile.ts --profile=guest:<digest> --campaign=<uuid> --apply
```

Add `--include-settings` only when this person owns the former shared settings and credentials. The import refuses to overwrite a target that already has credentials; it copies the old settings and preserves the original rows. Environment keys must be entered in the chosen profile explicitly. Imports are transactional, and campaigns already owned by someone cannot be reassigned by this utility. Copying settings cannot undo prior exposure of keys when the website was shared; their owner can replace those keys in the provider dashboard.

## Sharing

New campaigns and checkpoint branches default to private. An unchecked creation control allows explicit publication; owners can publish or unpublish from **Мои кампании → Управление кампанией**. Published stories appear under **Библиотека миров → Общие кампании**. Their content is readable, including journal export. **Продолжить в своей копии** creates a private campaign from its current saved position. The copy has independent state and belongs to the current player; only that player's own keys and settings can power its AI. Author credentials, telemetry, background jobs and checkpoints are never copied. Without a personal key, users can read and copy stories, and play preset campaigns offline; live AI requires their own key. Mutation, checkpoints, semantic search, compaction, indexing and AI calls remain owner-only on each personal campaign. Publication includes future turns while public. Unpublishing stops subsequent reads but cannot retract copies already downloaded.

All nested campaign APIs authorize in their route handler. Missing and inaccessible campaigns both return 404. Lists, settings, quotas, token history, verification reports, memory retry actions and queue statistics are profile-scoped. Public snapshot reads do not prewarm embeddings or spend the owner's key. Manual queue processing stays within the caller's profile; the CLI worker selects a campaign first and loads that owner's configuration.

## Verification

```powershell
npm run typecheck
npm test
npm run lint
npm run build
# Against a running application and disposable migrated PostgreSQL only:
node --env-file=.env --import tsx scripts/user-isolation-smoke.ts
node --env-file=.env --import tsx scripts/user-isolation-worker-smoke.ts
```

`SMOKE_BASE_URL` selects the application. The HTTP smoke uses independent cookie jars and dummy credentials; the worker smoke mocks provider traffic. `scripts/turn-latency-browser.ts` verifies the streamed narrative remains the same DOM node through commit and snapshot refresh.

Copy creation is idempotent per profile, source campaign and request identifier. It checks source visibility again inside the campaign lock; retrying cannot create duplicate copies or claim another profile's result. Published copies cannot modify their source, and a source owner cannot read a private copy made by someone else.

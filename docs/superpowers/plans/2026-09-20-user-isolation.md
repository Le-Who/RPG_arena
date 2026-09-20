# User isolation and stable streaming

**Goal:** Separate visitor settings and credentials, make campaigns private by default with explicit publication, and preserve the narrative DOM during streaming completion.

**Architecture:** No account/login system currently exists. Each browser receives a cryptographically random 256-bit HttpOnly, SameSite=Lax cookie (Secure on HTTPS). Its SHA-256 digest is the profile identifier; knowing an owner identifier cannot authenticate a visitor. Settings use this identifier. All campaign routes check read/owner permissions in the route handler. Background work resolves credentials from the campaign owner, never a global fallback. Server environment keys are not visitor credentials.

**Legacy data:** Existing campaigns keep a null owner and private visibility; global/local settings remain preserved but inaccessible to visitors. An explicit offline CLI can assign legacy campaigns and settings to a chosen profile. Never let the first visitor claim them automatically.

**Sharing:** Creation offers an unchecked publication control; owners may publish/unpublish from their campaign list. Library includes published campaigns. Visitors can read public stories and create personal private copies from the current saved position. Each player continues only their own copy using their own keys and progress; the original author never pays for another player. Source mutations remain owner-only. Branches remain owner-only and always start private.

**Guest lifetime:** Browser cookie identifies the profile across restarts, not across devices. Clearing cookies loses guest access; UI must explain this. Account recovery/login is outside this change.

## Implementation and verification

- [x] Add identity and access-policy tests: distinct cookies produce distinct profiles, malformed tokens fail, public read is allowed but mutations require ownership, legacy null ownership fails closed.
- [x] Add owner/visibility/token-log migration; scope settings, workspace, AI keys, quotas and TypeSafe settings.
- [x] Protect every session endpoint; scope lists, reports, retries and worker jobs. Keep public reads free of speculative AI calls.
- [x] Implement creation privacy control, campaign publication toggle and public library; source view is read-only with a personal-copy action.
- [x] Stabilize narrative keys by session/turn/role across preview, committed response and database refresh; preserve text until commit callback applies it.
- [x] Verify with unit tests, two independent HTTP cookie jars, direct cross-owner endpoint attempts, scoped background credentials, browser DOM continuity, typecheck, lint and build.

Existing uncommitted roadmap and .agents files belong to the user and are not part of this change.

## Clarification accepted during implementation

The user explicitly chose personal copies for playing public campaigns. Added POST /api/sessions/[id]/copy with scoped idempotency, locked read-authorization, remapped canonical state, private ownership for the caller, and no copied credentials or provider work. Foreground turn configuration is captured from the current player. Copy-flow verification is part of completion.

## Verification results

- 156 unit tests pass; typecheck, ESLint and production build pass.
- Production HTTP suite passes for two independent profiles, nested authorization, preferences/keys, reports, quotas, manual retries and personal copies (including concurrent duplicate requests).
- Mocked worker suite verifies owner-specific keys and dimensions and rejects owner/session mismatch before any provider call.
- Legacy importer dry-run, scoped assignment, preservation, credential overwrite refusal and transaction rollback pass.
- Browser tests assert article/prose/player node identity through preview, commit and DB refresh; delayed polling cannot regress the stage. Manual browser flow confirms private creation, publication and playable private copy from another guest.
- Existing basic, v2.2, TypeSafe and latency smoke harnesses updated for profile isolation and pass. No paid provider calls were needed.
- Verified additive migration on disposable PostgreSQL and reran it successfully. The project has no configured `.env`; no production database or deployment was modified. Apply the migration and explicitly assign legacy data when deploying, as documented in `docs/user-isolation.md`.

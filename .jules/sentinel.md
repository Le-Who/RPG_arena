## 2024-05-18 - Missing Access Control on Narrative POST Endpoint
**Vulnerability:** The POST endpoint in `src/app/api/settings/narrative/route.ts` was missing the `withIdentityWork` wrapper on the route handler export, allowing unauthenticated requests.
**Learning:** Next.js route handlers must be explicitly wrapped with access control middleware at the export level. The internal `withCurrentIdentityWork` wrapper is not sufficient for enforcing full authentication and CSRF protections.
**Prevention:** Always verify that every route handler (`GET`, `POST`, `PUT`, `DELETE`) export in the application is protected by an appropriate middleware wrapper like `withIdentityWork`, `withCampaignAccess`, or `withAdminAccess`.

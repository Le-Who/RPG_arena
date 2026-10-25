## 2024-05-24 - Missing Access Control on Next.js API Routes
**Vulnerability:** A Next.js API route (`src/app/api/settings/narrative/route.ts`) was missing access control middleware (`withIdentityWork`) at the export level for the POST method.
**Learning:** In Next.js App Router, middleware wrapped inside the handler (e.g. `withCurrentIdentityWork` inside `handlePOST`) allows potentially unauthenticated requests to reach the handler code (like payload reading) before authentication is enforced.
**Prevention:** Always apply access control middleware at the export level (`export const POST = withIdentityWork(handlePOST);`) to ensure authentication, CSRF protection, and diagnostics run before any handler logic.

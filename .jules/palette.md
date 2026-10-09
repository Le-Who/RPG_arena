## 2026-10-04 - Icon-Only Link Accessibility
**Learning:** Found that an icon-only `<Link>` element inside `src/components/story-records.tsx` pointing to a specific turn in the history lacked accessible text. Since there was no visible text inside the link itself, screen readers would not announce its purpose.
**Action:** Always add an `aria-label` to icon-only links or buttons, even if they visually follow contextual text (like "Ход 12"), so screen readers can announce the destination clearly.

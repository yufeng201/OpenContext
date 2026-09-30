# Web boundaries

Follow [frontend architecture](../../docs/FRONTEND_ARCHITECTURE.md) and [UI rules](../../docs/UI_GUIDELINES.md). The minimum application and its real API browser checks are described in [Web development](README.md).

- One stack: React/TypeScript/Vite, Tailwind/shadcn, React Router, TanStack Query, RHF. React local state first; Zustand only for a demonstrated cross-page UI need.
- API data belongs to Query; shareable filters/scope/revision belong to the URL. Never put authorization decisions or a second server-state cache in Zustand.
- Reuse TypeBox-derived contracts and JSON Schema validation; no parallel Zod API models. Web imports contracts, not server, SQLite, core or plugin host implementations.
- Render source text as untrusted data. No raw HTML by default. Keep citation revisions immutable and distinguish internal publication, index freshness and external publication.
- Revoke/401/403 clears affected cached content; hidden buttons are not authorization. Do not optimistically show a commit, merge or destructive operation as successful.

# OpenContext engineering entry

Read [development workflow](docs/DEVELOPMENT.md) and the task's acceptance criteria before editing. [Architecture decisions](docs/adr/0001-engineering-baseline.md), [design index](docs/README.md) and [first implementation slice](docs/tasks/P1-001-repo-recall.md) distinguish approved engineering defaults from proposed product behavior.

- This is a plugin-driven, self-hosted context platform. Preserve stable file identity, immutable revisions, current authorization, durable events/tasks and the internal publish gate. Feature plugins use host ports; they never bypass these gates or write the state database directly.
- Source and derived files share retrieval. Pin snapshot/revision/config references. InstanceRef is a configured instance revision; PluginRef is a package version. Never silently exchange them.
- A stale worker or generated result cannot overwrite human-owned output. Full/delta deletion, promotion and corrections follow the documented ownership/CAS rules. Prompt instructions are not enforcement.
- Keep TypeBox/JSON Schema as the contract authority. Do not add a parallel Zod API schema. Keep web, core, adapters and plugins within the import boundaries.
- Use synthetic fixtures and temporary data roots. No production secrets, paid model calls, permission expansion or external publishing as part of checks. Hooks are optional and disabled by default. Do not change user Agent configuration.
- Run `pnpm check` before reporting completion. Report which checks ran and distinguish design-rule validation from application tests. Do not call a zero-module boundary scan or an unimplemented E2E a passing application test.
- Preserve historical archives and unrelated edits. Commit, push, deployment and real integrations require task authorization; this harness does not grant it.

Directory rules are adjacent to the files they govern. Claude entry files import this rule source; edit AGENTS.md, not duplicate rule text.

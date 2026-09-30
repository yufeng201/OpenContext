# Design changes

Use the [design index](README.md) and [development workflow](DEVELOPMENT.md). Keep PRD requirements, technical contracts, blueprint examples and user journeys consistent. Preserve `checkpoint/` and `original-2026-09-30/` byte-for-byte unless the task explicitly changes archival policy.

Executable examples belong in fenced JSON/TypeScript/SQL and must pass `pnpm check:docs`. Update semantic fixtures when changing a rule, including a case that rejects the old or unsafe behavior. State clearly that this validates documented rules, not implemented storage, ACL, workers or UI.

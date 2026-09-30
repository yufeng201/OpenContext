# Harness checks

Checks must be deterministic, offline after dependency installation, and runnable from a fresh copy. Use the project-local toolchain, synthetic fixtures and disposable temporary directories. Clean up only directories created by the current check. Fail on violations and missing expected examples; do not silently skip them.

Every new checker needs a positive case and a violating fixture in `tests/harness/`. Do not access credentials, call model APIs or mutate application/Agent configuration. See [development workflow](../docs/DEVELOPMENT.md).

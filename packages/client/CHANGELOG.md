# @berry-agent/client

## 1.0.0 (2026-06-15)

First stable release. This package is the public contract for the a8s control plane.

### Breaking (vs 0.5.0-alpha)

- `A8sClientOptions.adminToken` removed. Use `token` instead.
- `operatorUsage()` renamed to `usage()`.
- `modelsTemplate()` (untyped duplicate) removed; use `getModelsTemplate()`.
- Product-readable API paths moved from `/v1/operator/*` to `/v1/catalog/*`
  (models-template, skills, hand-recipes). SDK callers are unaffected — only
  the wire path changed.

### Added

- 15 new methods covering all a8s routes (hand-recipes, skills, credentials,
  audit, admin-agent, wakes, machine MCP config).
- `health()` now returns `apiVersion: number`.
- Machine exec/mcp path constants added to cluster-protocol (`A8S_PATHS.machineExec` etc.).
- Re-exports for `HandRecipe`, `OperatorSkill*`, `Credential*`, `Audit*` types.

### Changed

- All machine methods use `A8S_PATHS.*` constants (no hardcoded strings).
- File header and JSDoc stripped to essentials.

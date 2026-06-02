// ============================================================
// @berry-agent/worker-daemon — Public API
// ============================================================

export { WorkerDaemon } from './daemon.js';
export type { WorkerDaemonOptions } from './daemon.js';

export { WorkerRegistrationClient } from './registration.js';
export type { RegistrationClientOptions } from './registration.js';

export { withTeamModeHostTools } from './team-mode.js';
export type { TeamModeResolverOptions, WireResolveInput } from './team-mode.js';

export { withAdminOpsEnv } from './admin-ops-mode.js';
export type { AdminOpsModeResolverOptions } from './admin-ops-mode.js';
export { createCredentialInjectingProvider } from './admin-ops-env.js';
export type { AdminOpsEnv } from './admin-ops-env.js';

export { withMachineHostTools } from './machine-mode.js';
export type { MachineModeResolverOptions } from './machine-mode.js';

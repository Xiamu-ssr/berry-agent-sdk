// ============================================================
// @berry-agent/machine-connector — Public API
// ============================================================

export { startMachineConnector, detectPlatform } from './connector.js';
export type {
  StartMachineConnectorOptions,
  RunningMachineConnector,
  MachinePlatform,
} from './connector.js';

export { MachineConnectorDaemon } from './daemon.js';
export type { MachineConnectorDaemonOptions } from './daemon.js';

export { MachineRegistrationClient } from './registration.js';
export type { MachineRegistrationClientOptions } from './registration.js';

export { MachineMcpHost } from './mcp-host.js';
export type { MachineMcpHostOptions } from './mcp-host.js';

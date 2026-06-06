# @berry-agent/machine-connector

A **machine connector** turns any host into a Hand source for an a8s cluster.
It is a tiny HTTP daemon — no agent brains run here — that registers with a8s
and exposes three primitives a8s proxies on the agent's behalf:

- `GET  /health` — liveness (unauthenticated)
- `POST /exec` — run an arbitrary shell command on this host (machine-token auth)
- `POST /mcp/invoke` — call one of this host's local MCP tools (machine-token auth)

`/exec` runs as the **identity of the process that started the connector**
(root if started as root, restricted if started as a normal user). That is the
physical guarantee that a machine's owner — not a8s — decides what the cluster
can do on it. a8s never exceeds that identity.

The connector projects its `exec` + each local MCP tool to the agent as Hands
(`machine_<id>_exec`, `machine_<id>__<server>_<tool>`).

## Two ways to run it — standalone or embedded

The package ships **one** orchestration entry point, `startMachineConnector()`,
used both by the `berry-machine` CLI and by any GUI that wants to bundle a
connector (e.g. the desktop console: install the app → it runs a local
connector that registers this Mac's MCP/files/shell with a8s).

### Standalone (headless Linux, throwaway box, CI)

```sh
berry-machine start --a8s https://a8s.example.com --admin-token SECRET
# optional: --machine-id, --port, --bind-host, --heartbeat-ttl, --mcp-config
```

The CLI parses flags, calls `startMachineConnector()`, installs SIGINT/SIGTERM
handlers (which call `stop()` to withdraw cleanly), and blocks.

### Embedded (bundled inside a GUI client)

```ts
import { startMachineConnector } from '@berry-agent/machine-connector';

const connector = await startMachineConnector({
  a8sUrl: 'https://a8s.example.com',
  adminToken,          // or rely on env BERRY_A8S_ADMIN_TOKEN
  // machineId defaults to os.hostname()
  // mcpConfigPath defaults to <cwd>/.mcp.json when present; pass null to disable
});

// ...app runs...

await connector.stop(); // withdraw from a8s, release the port, dispose MCP host
```

`startMachineConnector()` resolves once the daemon is listening **and**
registration succeeded; the heartbeat loop runs in the background until
`stop()`. It deliberately does **not** trap process signals — the embedder owns
its own lifecycle. If registration fails it tears the daemon back down rather
than leaking a bound port.

## Sandboxing

By default the connector runs commands through a bare `NodeExecutor` — the
cluster can do on this host whatever the starting shell can. For anything but a
throwaway box, inject a sandboxed `CommandExecutor` (`startMachineConnector`
takes an `executor` option) or run the connector as a low-privilege user.

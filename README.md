# Berry Agent SDK

> TypeScript SDK + control plane + worker daemon for building long-running
> multi-agent systems on top of Anthropic-style managed-agent architecture.

Berry is a **4-layer agent platform**:

| Layer | Package(s) | Role |
|---|---|---|
| 1 — SDK runtime | `@berry-agent/core` + 12 others | Per-agent harness: session, hands, sandbox, safety, observation |
| 2 — Worker | `@berry-agent/worker` + `@berry-agent/worker-daemon` | Single-machine runtime that mounts N agents, registers with a control plane |
| 3 — Control plane (a8s) | `@berry-agent/a8s` + `@berry-agent/a8s-server` + `@berry-agent/a8s-admin` + `@berry-agent/cluster-protocol` | Cluster-wide scheduling, lease management, operator API, built-in UI |
| 4 — Products | Out of this repo | UIs / CLIs / IDE plugins that drive Berry through the SDK or a8s HTTP API |

A 5-minute install gets you a single-host cluster with a web ops UI and a
chattable cluster-admin agent:

```bash
npm install -g @berry-agent/a8s-server
berry-a8s start --port 8080 \
  --store sqlite:///var/berry/a8s/orch.db \
  --admin-token $(openssl rand -hex 16) \
  --local-worker --admin-agent \
  --models-config /etc/berry/models.json

# Then open http://localhost:8080/ui in your browser, paste the admin token.
```

The full architecture, deployment forms, failure-mode contract, and package
inventory live in [`AGENTS.HTML`](./AGENTS.HTML) — open it in any browser. The
conceptual background (Anthropic's managed-agents paper + how Berry maps onto
it) lives in [`../docs/anthropic-managed-agents-notes.md`](../docs/anthropic-managed-agents-notes.md).

## Development

```bash
npm install
npm run build
npm test          # 748 tests
```

This is a TypeScript workspace; `npm run build` topologically builds every
package in dependency order. Tests use Vitest (`maxWorkers=2`).

## Status

Alpha. All 4 layers ship working code, but APIs may break between versions
without compatibility shims — this is deliberate while the surface settles.

## License

MIT

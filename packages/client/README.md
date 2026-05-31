# @berry-agent/client

The standard client every Berry **product** uses to talk to an a8s control
plane. a8s is the (remote) backend that runs agent brains; products are
thin front ends that drive agents through this client — no product
re-implements the a8s wire calls, and no product runs an engine of its own.

```ts
import { A8sClient } from '@berry-agent/client';

const a8s = new A8sClient({ a8sUrl: 'https://a8s.example.com', token: MY_TOKEN });

// Control-plane reads
await a8s.clusterReport();
await a8s.listAgents();

// Create + drive an agent
await a8s.createAgent({ spec: { agentId: 'coder', workspace: 'coder', model: 'tier:strong' } });
const coder = a8s.agent('coder');
await coder.send({ prompt: 'Refactor the auth module' });

// Live event stream (SSE, async iterable, auto-resumes via Last-Event-ID)
for await (const ev of coder.subscribe({ sessionId })) {
  console.log(ev.type, ev.data);
}
```

## Two surfaces

- **`A8sClient`** — the canonical typed HTTP client over the whole a8s API
  (operator, agent lifecycle, sessions, machine layer). Every response is
  parsed through a `cluster-protocol` zod schema, so a drifted server
  surfaces as a schema error, not a silently-typed `any`. Non-2xx throws
  `A8sRequestError` carrying status + path. The `token` may be a string or
  a `() => string | Promise<string>` provider — the provider form lets a
  product BFF inject a per-user token without rebuilding the client.

- **`AgentHandle`** (`a8s.agent(id)`) — the per-agent product data plane:
  `send`, `listSessions`, `listSessionEvents`, and `subscribe()` for a live
  SSE event stream. SSE is hand-parsed because `EventSource` can't send the
  auth header a8s requires.

## Relationship to `@berry-agent/a8s-admin`

`a8s-admin`'s historical `A8sOperatorClient` is now a re-export of this
package's `A8sClient` (single source of truth). `A8sClientOptions` accepts
both `token` and the legacy `adminToken`, so existing operator/CLI callers
keep working unchanged.

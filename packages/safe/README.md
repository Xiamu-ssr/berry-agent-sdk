# @berry-agent/safe

Safety guards, LLM classifier, prompt injection probe, and audit logging for Berry Agent SDK.

Inspired by [Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode).

## Install

```bash
npm install @berry-agent/safe
```

## Quick Start

```typescript
import { Agent } from '@berry-agent/core';
import { compositeGuard, allowList, directoryScope, denyList } from '@berry-agent/safe';

const agent = new Agent({
  provider: { type: 'anthropic', apiKey: '...', model: 'claude-sonnet-4-20250514' },
  systemPrompt: 'You are a coding assistant.',
  tools: [readFile, writeFile, bash],
  toolGuard: compositeGuard(
    allowList(['read_file', 'search', 'list_dir']),   // Tier 1: safe tools always allowed
    directoryScope('/my/project'),                      // Tier 2: restrict file ops
    denyList(['rm -rf', 'DROP TABLE', 'curl | bash']), // Tier 0: hard deny patterns
  ),
});
```

## Pre-built Guards (Tier 0 — zero cost)

```typescript
import { denyList, allowList, directoryScope, rateLimiter, compositeGuard } from '@berry-agent/safe';

// Deny by pattern (matches tool name + serialized input)
const deny = denyList(['rm -rf', 'DROP TABLE', '--force']);

// Allow only listed tools
const allow = allowList(['read_file', 'search', 'write_file']);

// Restrict file paths to a directory
const dirScope = directoryScope('/Users/me/project');

// Rate limit tool calls
const rateLimit = rateLimiter({ maxCalls: 30, windowMs: 60_000 });

// Compose: first deny wins, all must allow
const guard = compositeGuard(allow, dirScope, deny, rateLimit);
```

## LLM Transcript Classifier (Tier 2)

Two-stage, reasoning-blind classifier. Only sees user messages + tool call payloads (no assistant text, no tool results).

```typescript
import { createClassifierGuard } from '@berry-agent/safe';

const guard = createClassifierGuard({
  provider: { type: 'anthropic', apiKey: '...', model: 'claude-sonnet-4-20250514' },
  environment: {
    projectDir: '/my/project',
    trustedDomains: ['github.com/myorg'],
  },
  // Uses defaultBlockRules (17 rules) and defaultAllowExceptions (5 rules)
  // Customize: blockRules: [...defaultBlockRules, 'my custom rule'],
});

const agent = new Agent({
  toolGuard: guard,
  // ...
});
```

### Backpressure

The classifier tracks denials per session. After 3 consecutive or 20 total denials, it throws an error to escalate to a human (or terminate in headless mode).

## Prompt Injection Probe

Middleware that scans tool results for injection patterns. Doesn't block — prepends warnings.

```typescript
import { createPIProbeMiddleware } from '@berry-agent/safe';

const agent = new Agent({
  middleware: [createPIProbeMiddleware()],
  // ...
});
```

## Audit Logging

Wrap any guard with audit logging:

```typescript
import { withAudit, createMemoryAuditSink, createConsoleAuditSink } from '@berry-agent/safe';

const { sink, entries } = createMemoryAuditSink();
const auditedGuard = withAudit(myGuard, sink);

// Or log to console
const consoleGuard = withAudit(myGuard, createConsoleAuditSink());
```

## Architecture

```
Tier 0 — Pre-built Rules (zero cost)
  ├── denyList / allowList
  ├── directoryScope
  ├── rateLimiter
  └── compositeGuard

Tier 1 — Pattern Matching
  └── PI Probe (middleware, warns on injection patterns)

Tier 2 — LLM Classifier (reasoning-blind)
  ├── Stage 1: single-token fast filter
  └── Stage 2: CoT reasoning (same prompt → cache hit)

Cross-cutting
  ├── Backpressure (consecutive/total denial limits)
  └── Audit Log (wraps any guard)
```

## License

MIT

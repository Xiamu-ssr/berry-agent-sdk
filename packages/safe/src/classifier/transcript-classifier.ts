// ============================================================
// LLM Transcript Classifier — Two-stage, reasoning-blind
// ============================================================
// Based on Claude Code auto mode architecture:
// Stage 1: Fast single-token filter (err toward blocking)
// Stage 2: CoT reasoning (only if Stage 1 flags)
// Same prompt for both stages → Stage 2 is ~100% cache hit from Stage 1

import type { Provider, ProviderConfig, ToolGuard, Message } from '@berry-agent/core';
import type {
  ClassifierConfig,
  ClassifierDecision,
  BackpressureState,
  EnvironmentConfig,
} from '../types.js';
import { buildClassifierTranscript, formatTranscriptForClassifier } from './transcript-builder.js';

/** Default block rules (inspired by CC auto mode's 20+ rules). */
export const defaultBlockRules: string[] = [
  // Destroy or exfiltrate
  'Force-push or rewrite remote git history (e.g. git push --force to shared branches)',
  'Mass-delete cloud storage objects, database tables, or infrastructure resources',
  'Send internal data (source code, configs, credentials, logs) to external services not specified by the user',
  'Upload files to public hosting (gist, pastebin, public S3) without explicit user request',

  // Degrade security posture
  'Disable logging, monitoring, or audit trails',
  'Install persistent access (SSH keys, cron jobs, startup scripts) not requested by the user',
  'Modify the agent\'s own permission configuration or safety settings',
  'Disable or bypass security checks, pre-commit hooks, or CI gates',

  // Cross trust boundaries
  'Execute code cloned from external repositories not specified by the user',
  'Scan credential stores, environment variables, or config files for usable tokens beyond the current task',
  'Send data to services or domains the user never specified',
  'Access or modify files outside the project directory without explicit user instruction',

  // Bypass review or affect others
  'Push directly to main/master/production branches without user confirmation',
  'Run production deployments, migrations, or infrastructure changes',
  'Modify shared resources, jobs, or branches the agent did not create',
  'Skip verification flags or safety checks on commands that have them (e.g. --force, --skip-verify)',
  'Kill, restart, or modify processes/services not started by the agent in this session',
];

/** Default allow exceptions (narrow carve-outs). */
export const defaultAllowExceptions: string[] = [
  'Installing packages already declared in the project manifest (package.json, requirements.txt, Cargo.toml, etc.)',
  'Standard credential flows (npm login, gh auth, docker login) when the user has initiated the task',
  'Pushing to the agent\'s working branch (not main/master/production)',
  'Reading environment variables needed for the current task (not scanning for other credentials)',
  'Running test suites and linters within the project directory',
];

/**
 * Build the classifier system prompt.
 * Fixed template + 3 customizable slots (environment, block rules, allow exceptions).
 */
function buildClassifierPrompt(
  environment: EnvironmentConfig | undefined,
  blockRules: string[],
  allowExceptions: string[],
): string {
  const envSection = buildEnvironmentSection(environment);

  return `You are a security classifier for an AI coding agent. Your job is to evaluate whether a tool call should be ALLOWED or BLOCKED before it executes.

You act as a substitute for a human approver. Be conservative: when in doubt, BLOCK.

<evaluation_rules>
Evaluate the REAL-WORLD IMPACT of the action, not just the surface text.
- If the agent writes a payload to a file and then runs it, evaluate the payload.
- If commands are chained with && or ||, evaluate the entire chain as one action.
- If the agent writes a script that assembles a shell command, evaluate the assembled command.
- Look at what the action ACTUALLY DOES, not what it appears to do.
</evaluation_rules>

<user_intent_rules>
Determine whether the action is something the USER AUTHORIZED, not just related to the user's goal.
- Only explicit user instructions count as authorization.
- "Clean up my branches" does NOT authorize batch-deleting remote branches.
- "Can we fix this?" is a QUESTION, not a directive — it does not authorize changes.
- A similar action approved earlier is not blanket approval for escalated versions.
- Everything the agent chooses on its own is UNAUTHORIZED until the user says otherwise.
</user_intent_rules>

<environment>
${envSection}
</environment>

<block_rules>
Block the action if it matches any of these categories:
${blockRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}
</block_rules>

<allow_exceptions>
Allow the action even if a block rule matches, if it falls under these exceptions:
${allowExceptions.map((r, i) => `${i + 1}. ${r}`).join('\n')}
</allow_exceptions>

<classification_process>
Step 1: Identify what the action actually does (apply evaluation rules).
Step 2: Check against block rules. If none match → ALLOW.
Step 3: If a block rule matches, check allow exceptions. If an exception applies → ALLOW.
Step 4: Check user intent. Did the user explicitly authorize this specific action? If yes → ALLOW.
Step 5: If no exception or authorization applies → BLOCK.
</classification_process>`;
}

function buildEnvironmentSection(env?: EnvironmentConfig): string {
  const parts: string[] = [];
  if (env?.projectDir) {
    parts.push(`Trusted project directory: ${env.projectDir}`);
  }
  if (env?.trustedDomains?.length) {
    parts.push(`Trusted domains: ${env.trustedDomains.join(', ')}`);
  }
  if (env?.trustedBuckets?.length) {
    parts.push(`Trusted cloud buckets: ${env.trustedBuckets.join(', ')}`);
  }
  if (parts.length === 0) {
    parts.push('Only the current git repository is trusted. Everything else is external.');
  }
  return parts.join('\n');
}

/**
 * Create a two-stage LLM transcript classifier as a ToolGuard.
 *
 * Usage:
 * ```ts
 * const guard = createClassifierGuard({
 *   provider: { type: 'anthropic', apiKey: '...', model: 'claude-sonnet-4-20250514' },
 *   environment: { projectDir: '/my/project' },
 * });
 * const agent = new Agent({ toolGuard: guard });
 * ```
 */
export function createClassifierGuard(config: ClassifierConfig): ToolGuard {
  let provider: Provider | null = config.providerInstance ?? null;
  const systemPrompt = buildClassifierPrompt(
    config.environment,
    config.blockRules ?? defaultBlockRules,
    config.allowExceptions ?? defaultAllowExceptions,
  );
  const maxConsecutive = config.maxConsecutiveDenials ?? 3;
  const maxTotal = config.maxTotalDenials ?? 20;

  // Per-session backpressure state
  const stateMap = new Map<string, BackpressureState>();

  function getState(sessionId: string): BackpressureState {
    let state = stateMap.get(sessionId);
    if (!state) {
      state = { consecutiveDenials: 0, totalDenials: 0 };
      stateMap.set(sessionId, state);
    }
    return state;
  }

  async function getProvider(): Promise<Provider> {
    if (provider) return provider;
    // Lazy-create provider
    const { AnthropicProvider, OpenAIProvider } = await import('@berry-agent/core');
    const cfg = config.provider;
    provider = cfg.type === 'anthropic'
      ? new AnthropicProvider(cfg)
      : new OpenAIProvider(cfg);
    return provider;
  }

  const guard: ToolGuard = async (ctx) => {
    const sessionId = ctx.session.id;
    const state = getState(sessionId);

    // Backpressure check
    if (state.consecutiveDenials >= maxConsecutive || state.totalDenials >= maxTotal) {
      throw new Error(
        `Safety backpressure: ${state.consecutiveDenials} consecutive denials ` +
        `(limit: ${maxConsecutive}) or ${state.totalDenials} total denials ` +
        `(limit: ${maxTotal}). Escalating to human.`
      );
    }

    // Build reasoning-blind transcript
    // Note: we need the session messages but ToolGuardContext doesn't include them.
    // The classifier works with the current action alone when no messages are available.
    const currentAction = { name: ctx.toolName, input: ctx.input };

    // Call classifier
    const decision = await classifyAction(
      await getProvider(),
      systemPrompt,
      currentAction,
      config.skipStage2 ?? false,
    );

    // Update backpressure state
    if (decision.action === 'deny') {
      state.consecutiveDenials++;
      state.totalDenials++;
      return { action: 'deny', reason: decision.reason ?? 'Blocked by safety classifier' };
    }

    // Reset consecutive on allow
    state.consecutiveDenials = 0;
    return { action: 'allow' };
  };

  return guard;
}

/**
 * Classify a single action using two-stage pipeline.
 */
async function classifyAction(
  provider: Provider,
  systemPrompt: string,
  action: { name: string; input: Record<string, unknown> },
  skipStage2: boolean,
): Promise<ClassifierDecision> {
  const actionText = `<current_action>\n<tool name="${action.name}">${JSON.stringify(action.input)}</tool>\n</current_action>`;

  // Stage 1: Fast single-token filter
  const stage1Messages: Message[] = [
    {
      role: 'user',
      content: `${actionText}\n\nShould this action be BLOCKED? Answer with a single word: YES (block) or NO (allow). Err on the side of blocking.`,
      createdAt: Date.now(),
    },
  ];

  const stage1Response = await provider.chat({
    systemPrompt: [systemPrompt],
    messages: stage1Messages,
    tools: [],
  });

  const stage1Text = extractResponseText(stage1Response).trim().toUpperCase();
  const stage1Blocked = stage1Text.startsWith('YES');

  if (!stage1Blocked) {
    return { action: 'allow', stage: 1 };
  }

  if (skipStage2) {
    return { action: 'deny', reason: 'Blocked by Stage 1 fast filter', stage: 1 };
  }

  // Stage 2: CoT reasoning (same system prompt → cache hit!)
  const stage2Messages: Message[] = [
    {
      role: 'user',
      content: `${actionText}\n\nCarefully evaluate whether this action should be BLOCKED or ALLOWED. Think step by step through the classification process, then give your final decision.\n\nFormat your response as:\n<reasoning>Your step-by-step analysis</reasoning>\n<decision>ALLOW or BLOCK</decision>\n<reason>Brief explanation if blocking</reason>`,
      createdAt: Date.now(),
    },
  ];

  const stage2Response = await provider.chat({
    systemPrompt: [systemPrompt],
    messages: stage2Messages,
    tools: [],
  });

  const stage2Text = extractResponseText(stage2Response);

  // Parse decision
  const decisionMatch = stage2Text.match(/<decision>\s*(ALLOW|BLOCK)\s*<\/decision>/i);
  const reasonMatch = stage2Text.match(/<reason>([\s\S]*?)<\/reason>/i);

  if (decisionMatch && decisionMatch[1]!.toUpperCase() === 'ALLOW') {
    return { action: 'allow', stage: 2 };
  }

  return {
    action: 'deny',
    reason: reasonMatch?.[1]?.trim() ?? 'Blocked by Stage 2 classifier',
    stage: 2,
  };
}

function extractResponseText(response: { content: unknown }): string {
  const content = response.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

// Export for testing
export { buildClassifierPrompt, classifyAction };

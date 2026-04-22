// ============================================================
// Berry Agent SDK — Tool Executor
// ============================================================
// Extracted from agent.ts: parallel tool execution with guard
// checks, middleware, and event logging.

import type {
  ToolUseContent,
  ToolRegistration,
  ToolGuard,
  Middleware,
  MiddlewareContext,
  ContentBlock,
  Session,
  AgentEvent,
} from './types.js';
import type { SessionEvent } from './event-log/types.js';

export interface ExecuteToolsParams {
  toolUses: ToolUseContent[];
  tools: Map<string, ToolRegistration>;
  toolGuard?: ToolGuard;
  middleware: Middleware[];
  session: Session;
  emit: (event: AgentEvent) => void;
  appendEvent: (event: SessionEvent) => Promise<void>;
  makeBase: () => { id: string; timestamp: number; sessionId: string; turnId?: string };
  middlewareContext: MiddlewareContext;
  cwd: string;
  abortSignal?: AbortSignal;
}

export interface ExecuteToolsResult {
  results: ContentBlock[];
  toolCalls: number;
}

/**
 * Execute tool calls in parallel with guard checks, middleware hooks,
 * and event logging.
 */
export async function executeTools(params: ExecuteToolsParams): Promise<ExecuteToolsResult> {
  const {
    toolUses,
    tools,
    toolGuard,
    middleware,
    session,
    emit,
    appendEvent,
    makeBase,
    middlewareContext: mwCtx,
    cwd,
    abortSignal,
  } = params;

  let toolCalls = 0;

  // Emit all tool_call events first
  for (const toolUse of toolUses) {
    toolCalls++;
    emit({ type: 'tool_call', name: toolUse.name, input: toolUse.input });
  }

  const toolResultBlocks: ContentBlock[] = await Promise.all(
    toolUses.map(async (toolUse): Promise<ContentBlock> => {
      const tool = tools.get(toolUse.name);
      if (!tool) {
        emit({ type: 'tool_result', name: toolUse.name, isError: true });
        return {
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: `Error: unknown tool "${toolUse.name}"`,
          isError: true,
        };
      }

      // Event log: tool_use_start (before execution)
      await appendEvent({
        ...makeBase(),
        type: 'tool_use_start',
        name: toolUse.name,
        toolUseId: toolUse.id,
        input: toolUse.input,
      });

      // Event log: legacy tool_use (keep for backward compat)
      await appendEvent({
        ...makeBase(),
        type: 'tool_use',
        name: toolUse.name,
        toolUseId: toolUse.id,
        input: toolUse.input,
      });

      // Tool guard check
      let guardedInput = toolUse.input;
      if (toolGuard) {
        const guardStart = Date.now();
        const decision = await toolGuard({
          toolName: toolUse.name,
          input: toolUse.input,
          session: {
            id: session.id,
            cwd: session.metadata.cwd,
            model: session.metadata.model,
          },
          callIndex: toolCalls,
        });
        const guardDuration = Date.now() - guardStart;

        // Event log: guard_decision
        await appendEvent({
          ...makeBase(),
          type: 'guard_decision',
          toolName: toolUse.name,
          decision,
        });

        emit({
          type: 'guard_decision',
          toolName: toolUse.name,
          input: toolUse.input,
          decision,
          callIndex: toolCalls,
          durationMs: guardDuration,
        });

        if (decision.action === 'deny') {
          const denyContent = `Permission denied: ${decision.reason}`;
          // Event log: tool_result (denied) + tool_use_end
          await appendEvent({
            ...makeBase(),
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: denyContent,
            isError: true,
          });
          await appendEvent({
            ...makeBase(),
            type: 'tool_use_end',
            toolUseId: toolUse.id,
            output: denyContent,
            isError: true,
          });
          emit({ type: 'tool_result', name: toolUse.name, isError: true });
          return {
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: denyContent,
            isError: true,
          };
        }
        if (decision.action === 'modify') {
          guardedInput = decision.input;
        }
      }

      try {
        // Middleware: onBeforeToolExec
        for (const mw of middleware) {
          if (mw.onBeforeToolExec) {
            guardedInput = await mw.onBeforeToolExec(toolUse.name, guardedInput, mwCtx);
          }
        }

        const result = await tool.execute(guardedInput, {
          cwd,
          abortSignal,
        });

        // Middleware: onAfterToolExec
        for (const mw of middleware) {
          if (mw.onAfterToolExec) {
            await mw.onAfterToolExec(toolUse.name, guardedInput, result, mwCtx);
          }
        }

        const resultContent = result.forLLM ?? result.content;
        // Event log: tool_result + tool_use_end
        await appendEvent({
          ...makeBase(),
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: resultContent,
          isError: result.isError ?? false,
        });
        await appendEvent({
          ...makeBase(),
          type: 'tool_use_end',
          toolUseId: toolUse.id,
          output: resultContent,
          isError: result.isError ?? false,
        });

        emit({ type: 'tool_result', name: toolUse.name, isError: result.isError ?? false });
        return {
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: resultContent,
          isError: result.isError,
        };
      } catch (err) {
        const errContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
        // Event log: tool_result (error) + tool_use_end
        await appendEvent({
          ...makeBase(),
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: errContent,
          isError: true,
        });
        await appendEvent({
          ...makeBase(),
          type: 'tool_use_end',
          toolUseId: toolUse.id,
          output: errContent,
          isError: true,
        });

        emit({ type: 'tool_result', name: toolUse.name, isError: true });
        return {
          type: 'tool_result',
          toolUseId: toolUse.id,
          content: errContent,
          isError: true,
        };
      }
    }),
  );

  return { results: toolResultBlocks, toolCalls };
}

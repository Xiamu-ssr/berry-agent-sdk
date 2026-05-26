import type {
  DelegateConfig,
  DelegateResult,
} from '../agent-runtime-types.js';
import type { ToolRegistration } from '../tool-types.js';
import { ToolGroup } from '../tool-types.js';
import type { Skill } from '../skills/types.js';
import { TOOL_DELEGATE, TOOL_LOAD_SKILL } from '../tool-names.js';

export interface BuiltinAgentToolDeps {
  tools: Map<string, ToolRegistration>;
  hasSkillDirs(): boolean;
  loadSkill(name: string): Promise<Skill | null>;
  enableDelegate: boolean;
  delegate(message: string, config?: DelegateConfig): Promise<DelegateResult>;
}

export function registerBuiltinAgentTools(deps: BuiltinAgentToolDeps): void {
  registerLoadSkillTool(deps);
  registerDelegateTool(deps);
}

function registerLoadSkillTool(deps: BuiltinAgentToolDeps): void {
  if (!deps.hasSkillDirs() || deps.tools.has(TOOL_LOAD_SKILL)) return;
  deps.tools.set(TOOL_LOAD_SKILL, {
    definition: {
      name: TOOL_LOAD_SKILL,
      group: ToolGroup.Agent,
      description: 'Load the full content of a skill by name. Only use when a task matches a skill from the available skills index in the system prompt.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The exact name of the skill to load (from the skills index).',
          },
        },
        required: ['name'],
      },
    },
    execute: async (input) => {
      const skillName = input.name as string;
      const skill = await deps.loadSkill(skillName);
      if (!skill) {
        return {
          content: `Skill "${skillName}" not found. Check the available skills in the system prompt.`,
          isError: true,
        };
      }
      return { content: skill.content };
    },
  });
}

function registerDelegateTool(deps: BuiltinAgentToolDeps): void {
  if (!deps.enableDelegate || deps.tools.has(TOOL_DELEGATE)) return;
  deps.tools.set(TOOL_DELEGATE, {
    definition: {
      name: TOOL_DELEGATE,
      group: ToolGroup.Agent,
      description: 'Fork a temporary sub-agent to handle a complex sub-task. ' +
        'The sub-agent inherits your context and tools, executes independently, and returns the result. ' +
        'Use when a task is self-contained and can be done in isolation without further interaction.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Clear description of the sub-task to delegate.',
          },
          allowedTools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: restrict which tools the sub-agent can use (names). If omitted, inherits all.',
          },
        },
        required: ['task'],
      },
    },
    execute: async (input) => {
      try {
        const result = await deps.delegate(input.task as string, {
          allowedTools: input.allowedTools as string[] | undefined,
        });
        return {
          content: result.text,
          forUser: `[Delegated: ${(input.task as string).slice(0, 80)}... -> ${result.turns} turns, ${result.toolCalls} tool calls]`,
        };
      } catch (err) {
        return {
          content: `Delegate failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}

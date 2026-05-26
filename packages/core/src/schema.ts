// ============================================================
// Berry Agent SDK — Public Domain Schemas
// ============================================================

import { z } from 'zod';
import type {
  AnnotationContent,
  ContentBlock,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
} from './content-types.js';
import type { AgentHomeSnapshot } from './agent-home.js';
import type { ProjectSharedPaths } from './workspace/project-layout.js';

export type UserContentBlock = TextContent | ImageContent | AnnotationContent;

export const zTextContent = z.object({
  type: z.literal('text'),
  text: z.string(),
}) satisfies z.ZodType<TextContent>;

export const zToolUseContent = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.unknown()),
}) satisfies z.ZodType<ToolUseContent>;

export const zToolResultContent = z.object({
  type: z.literal('tool_result'),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
}) satisfies z.ZodType<ToolResultContent>;

export const zThinkingContent = z.object({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string().optional(),
}) satisfies z.ZodType<ThinkingContent>;

export const zImageContent = z.object({
  type: z.literal('image'),
  data: z.string(),
  mediaType: z.string(),
}) satisfies z.ZodType<ImageContent>;

export const zAnnotationContent = z.object({
  type: z.literal('annotation'),
  body: z.string(),
  source: z.object({
    url: z.string(),
    title: z.string().optional(),
  }),
  rect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  viewport: z.object({
    width: z.number(),
    height: z.number(),
  }),
  image: z.object({
    data: z.string(),
    mediaType: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
}) satisfies z.ZodType<AnnotationContent>;

/** User-authored multimodal input blocks accepted by chat entry points. */
export const zUserContentBlock: z.ZodType<UserContentBlock> = z.discriminatedUnion('type', [
  zTextContent,
  zImageContent,
  zAnnotationContent,
]);

/** Full SDK provider-context block union, including assistant/tool blocks. */
export const zContentBlock: z.ZodType<ContentBlock> = z.discriminatedUnion('type', [
  zTextContent,
  zToolUseContent,
  zToolResultContent,
  zThinkingContent,
  zImageContent,
  zAnnotationContent,
]);

/** SDK-owned project collaboration layout exposed to host UIs as read-only facts. */
export const zProjectSharedPaths = z.object({
  root: z.string(),
  contextPath: z.string(),
  berryDir: z.string(),
  teamPath: z.string(),
  teamMessagesPath: z.string(),
  worklistPath: z.string(),
  safetyPath: z.string(),
}) satisfies z.ZodType<ProjectSharedPaths>;

/** SDK-owned agent workspace layout exposed to host UIs as read-only facts. */
export const zAgentHomeSnapshot = z.object({
  root: z.string(),
  sessionsDir: z.string(),
  skillsDir: z.string(),
  mcpConfigPath: z.string(),
  memoryPath: z.string(),
  agentMdPath: z.string(),
  metadataPath: z.string(),
}) satisfies z.ZodType<AgentHomeSnapshot>;

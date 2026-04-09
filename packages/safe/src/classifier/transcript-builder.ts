// ============================================================
// Transcript Builder — Reasoning-blind transcript for classifier
// ============================================================
// Based on Claude Code auto mode design:
// - Only user messages + tool call payloads
// - Strip assistant text (prevents agent self-advocacy)
// - Strip tool results (prevents prompt injection reaching classifier)

import type { Message, ContentBlock } from '@berry-agent/core';
import type { ClassifierTranscript } from '../types.js';

/**
 * Build a reasoning-blind transcript from conversation history.
 * The classifier sees ONLY:
 *   1. User messages (text content)
 *   2. Tool call payloads (name + input, no descriptions or results)
 *
 * This design is intentional (from Anthropic's auto mode research):
 * - Stripping assistant text prevents the agent from "talking the classifier
 *   into a bad call" with persuasive rationalizations
 * - Stripping tool results prevents prompt injection content from
 *   reaching the classifier's context
 */
export function buildClassifierTranscript(
  messages: Message[],
  currentAction: { name: string; input: Record<string, unknown> },
): ClassifierTranscript {
  const userMessages: string[] = [];
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Extract text from user messages only
      if (typeof msg.content === 'string') {
        userMessages.push(msg.content);
      } else if (Array.isArray(msg.content)) {
        // User messages may contain text blocks (not tool_result blocks)
        for (const block of msg.content) {
          if ((block as any).type === 'text') {
            userMessages.push((block as any).text);
          }
          // Skip tool_result blocks — they contain tool outputs which
          // could carry prompt injection payloads
        }
      }
    } else if (msg.role === 'assistant') {
      // Extract only tool_use blocks (name + input), skip text blocks
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === 'tool_use') {
            toolCalls.push({
              name: (block as any).name,
              input: (block as any).input,
            });
          }
          // Skip text blocks — assistant prose is not shown to classifier
          // Skip thinking blocks — reasoning is not shown to classifier
        }
      }
      // If content is string, it's pure text — skip entirely
    }
  }

  return { userMessages, toolCalls, currentAction };
}

/**
 * Format transcript into a string for the classifier prompt.
 */
export function formatTranscriptForClassifier(transcript: ClassifierTranscript): string {
  const parts: string[] = [];

  parts.push('<user_messages>');
  for (const msg of transcript.userMessages) {
    parts.push(`<message>${msg}</message>`);
  }
  parts.push('</user_messages>');

  parts.push('');
  parts.push('<previous_tool_calls>');
  for (const call of transcript.toolCalls) {
    parts.push(`<tool name="${call.name}">${JSON.stringify(call.input)}</tool>`);
  }
  parts.push('</previous_tool_calls>');

  parts.push('');
  parts.push('<current_action>');
  parts.push(`<tool name="${transcript.currentAction.name}">${JSON.stringify(transcript.currentAction.input)}</tool>`);
  parts.push('</current_action>');

  return parts.join('\n');
}

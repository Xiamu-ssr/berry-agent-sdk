import { describe, expect, it } from 'vitest';
import {
  zAgentChatMessage,
  zAgentSessionView,
  zChatToolCall,
} from '../chat-schema.js';

describe('chat view schemas', () => {
  it('validates SDK session views with multimodal user blocks', () => {
    const parsed = zAgentSessionView.parse({
      id: 'session_1',
      title: 'Review dashboard',
      createdAt: 10,
      lastActiveAt: 20,
      agentId: 'agent_1',
      status: 'idle',
      messages: [
        {
          id: 'msg_1',
          role: 'user',
          content: 'look here',
          timestamp: 10,
          blocks: [
            { type: 'text', text: 'look here' },
            {
              type: 'annotation',
              body: 'CTA overlaps at this width',
              source: { url: 'https://example.test', title: 'Dashboard' },
              rect: { x: 1, y: 2, width: 30, height: 40 },
              viewport: { width: 1280, height: 720 },
              image: { data: 'iVBORw0KGgo=', mediaType: 'image/png', width: 30, height: 40 },
            },
          ],
        },
      ],
    });

    expect(parsed.messages[0]?.blocks?.[1]?.type).toBe('annotation');
  });

  it('keeps provider/tool blocks out of persisted user message blocks', () => {
    expect(() => zAgentChatMessage.parse({
      id: 'msg_1',
      role: 'user',
      content: 'bad block',
      timestamp: 10,
      blocks: [{ type: 'tool_use', id: 'tool_1', name: 'shell', input: {} }],
    })).toThrow();
  });

  it('requires tool call inputs to be object-shaped SDK tool arguments', () => {
    expect(zChatToolCall.parse({
      name: 'shell',
      input: { command: 'pwd' },
      result: '/tmp/workspace',
    }).input).toEqual({ command: 'pwd' });

    expect(() => zChatToolCall.parse({
      name: 'shell',
      input: 'pwd',
    })).toThrow();
  });
});

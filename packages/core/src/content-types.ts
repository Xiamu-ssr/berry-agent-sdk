// ============================================================
// Berry Agent SDK — Canonical Message Content
// ============================================================
// Provider adapters convert these SDK-owned blocks to/from wire formats.

export type Role = 'user' | 'assistant';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  /** Anthropic thinking signature; must be preserved for multi-turn continuity. */
  signature?: string;
}

export interface ImageContent {
  type: 'image';
  /** Base64-encoded image data. */
  data: string;
  /** Media type, e.g. image/jpeg, image/png, image/webp, image/gif. */
  mediaType: string;
}

export interface AnnotationContent {
  type: 'annotation';
  /** Human-authored annotation text. */
  body: string;
  source: {
    /** URL or file shown when the annotation was created. */
    url: string;
    title?: string;
  };
  /** Selection rectangle in viewport CSS pixels. */
  rect: { x: number; y: number; width: number; height: number };
  /** Browser viewport size in CSS pixels when captured. */
  viewport: { width: number; height: number };
  /** Cropped screenshot with the selected region highlighted. */
  image: {
    data: string;
    mediaType: string;
    width?: number;
    height?: number;
  };
}

export type ContentBlock =
  | TextContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent
  | ImageContent
  | AnnotationContent;

export interface Message {
  role: Role;
  content: string | ContentBlock[];
  /** Whether this message has been compacted. */
  compacted?: boolean;
  /** Timestamp. */
  createdAt?: number;
}

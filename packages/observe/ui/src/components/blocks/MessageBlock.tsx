// ============================================================
// MessageBlock — renders a single Berry-format content block
// ============================================================
//
// Berry messages have `content` that is either a string or an array of blocks.
// Each block has a `type` field: "text", "tool_use", "tool_result", "thinking".
// This component dispatches to the appropriate card.
// ============================================================

import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench, CheckCircle, XCircle, Brain, Image } from 'lucide-react';
import { Markdown } from './Markdown';

// ---- Types (loose — Observe stores arbitrary JSON) ----
interface TextBlock {
  type: 'text';
  text: string;
}
interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string; source?: unknown }>;
  is_error?: boolean;
}
interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}
interface ImageBlock {
  type: 'image';
  source?: { type: string; media_type?: string; data?: string; url?: string };
}

type Block = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | ImageBlock | { type: string; [k: string]: unknown };

// ---- Main dispatcher ----
export function MessageBlock({ block }: { block: Block }) {
  switch (block.type) {
    case 'text':
      return <TextCard text={(block as TextBlock).text} />;
    case 'tool_use':
      return <ToolUseCard block={block as ToolUseBlock} />;
    case 'tool_result':
      return <ToolResultCard block={block as ToolResultBlock} />;
    case 'thinking':
      return <ThinkingCard text={(block as ThinkingBlock).thinking} />;
    case 'image':
      return <ImageCard block={block as ImageBlock} />;
    default:
      return <FallbackCard block={block} />;
  }
}

// ---- Text ----
function TextCard({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="text-gray-800 dark:text-gray-200">
      <Markdown text={text} />
    </div>
  );
}

// ---- Tool Use ----
function ToolUseCard({ block }: { block: ToolUseBlock }) {
  const [open, setOpen] = useState(false);
  const inputStr = JSON.stringify(block.input, null, 2);
  const isLarge = inputStr.length > 300;
  return (
    <div className="border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-blue-50 dark:bg-blue-900/30 text-sm font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition-colors"
      >
        <Wrench size={14} />
        <span className="font-mono">{block.name}</span>
        <span className="text-blue-400 dark:text-blue-500 text-xs ml-auto font-mono">{block.id?.slice(0, 12)}</span>
        {isLarge && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
      </button>
      {(!isLarge || open) && (
        <pre className="px-3 py-2 text-xs font-mono bg-white dark:bg-gray-900/50 text-gray-700 dark:text-gray-300 overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre-wrap break-all">
          {inputStr}
        </pre>
      )}
    </div>
  );
}

// ---- Tool Result ----
function ToolResultCard({ block }: { block: ToolResultBlock }) {
  const [expanded, setExpanded] = useState(false);
  const isError = block.is_error;
  const borderColor = isError ? 'border-red-200 dark:border-red-800' : 'border-green-200 dark:border-green-800';
  const headerBg = isError ? 'bg-red-50 dark:bg-red-900/30' : 'bg-green-50 dark:bg-green-900/30';
  const headerText = isError ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300';

  // Normalize content to string
  let contentStr: string;
  if (typeof block.content === 'string') {
    contentStr = block.content;
  } else if (Array.isArray(block.content)) {
    contentStr = block.content.map(c => c.text ?? JSON.stringify(c)).join('\n');
  } else {
    contentStr = JSON.stringify(block.content);
  }

  const isTruncated = contentStr.includes('"truncated-at-500kb"');
  const isLarge = contentStr.length > 500;
  const displayStr = !expanded && isLarge ? contentStr.slice(0, 500) : contentStr;

  return (
    <div className={`border ${borderColor} rounded-lg overflow-hidden`}>
      <div className={`flex items-center gap-2 px-3 py-2 ${headerBg} text-sm font-medium ${headerText}`}>
        {isError ? <XCircle size={14} /> : <CheckCircle size={14} />}
        <span>tool_result</span>
        <span className="text-xs font-mono opacity-60">{block.tool_use_id?.slice(0, 12)}</span>
        {isTruncated && <span className="text-xs bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-400 px-1.5 py-0.5 rounded ml-auto">truncated</span>}
      </div>
      <pre className="px-3 py-2 text-xs font-mono bg-white dark:bg-gray-900/50 text-gray-700 dark:text-gray-300 overflow-x-auto max-h-[400px] overflow-y-auto whitespace-pre-wrap break-all">
        {displayStr}
      </pre>
      {isLarge && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full px-3 py-1.5 text-xs text-center text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 border-t border-gray-100 dark:border-gray-700 transition-colors"
        >
          {expanded ? '▲ Collapse' : `▼ Show full (${(contentStr.length / 1024).toFixed(1)}KB)`}
        </button>
      )}
    </div>
  );
}

// ---- Thinking ----
function ThinkingCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-purple-200 dark:border-purple-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-purple-50 dark:bg-purple-900/30 text-sm font-medium text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900/50 transition-colors"
      >
        <Brain size={14} />
        <span>thinking</span>
        <span className="text-xs text-purple-400 dark:text-purple-500 ml-auto">{text.length} chars</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </button>
      {open && (
        <div className="px-3 py-2 bg-white dark:bg-gray-900/50 max-h-[400px] overflow-y-auto">
          <Markdown text={text} />
        </div>
      )}
    </div>
  );
}

// ---- Image ----
function ImageCard({ block }: { block: ImageBlock }) {
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
      <Image size={14} />
      <span>Image ({block.source?.media_type ?? 'unknown'})</span>
    </div>
  );
}

// ---- Fallback for unknown block types ----
function FallbackCard({ block }: { block: Block }) {
  return (
    <pre className="text-xs font-mono bg-gray-50 dark:bg-gray-900/50 p-3 rounded-lg overflow-x-auto max-h-[200px] overflow-y-auto whitespace-pre-wrap break-all text-gray-600 dark:text-gray-400">
      {JSON.stringify(block, null, 2)}
    </pre>
  );
}

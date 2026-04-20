// ============================================================
// Markdown renderer for Berry Observe UI
// ============================================================
//
// Wraps react-markdown + remark-gfm with a dark-mode-aware code highlighter.
// Used for text blocks in messages and response content. Keeps link/table/code
// rendering consistent across the Turn Detail / Inference Detail views.
// ============================================================

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useEffect, useState } from 'react';

export function Markdown({ text }: { text: string }) {
  const isDark = useIsDark();
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children, ...rest } = props as {
              className?: string;
              children?: React.ReactNode;
            };
            const match = /language-(\w+)/.exec(className ?? '');
            const text = String(children ?? '').replace(/\n$/, '');
            // Inline code: no lang → render as plain <code>
            if (!match) {
              return (
                <code
                  className="px-1 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-pink-600 dark:text-pink-400 text-[0.85em]"
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <SyntaxHighlighter
                language={match[1]}
                style={(isDark ? oneDark : oneLight) as Record<string, React.CSSProperties>}
                PreTag="div"
                customStyle={{ margin: 0, borderRadius: 8, fontSize: 12 }}
              >
                {text}
              </SyntaxHighlighter>
            );
          },
          a(props) {
            return (
              <a
                {...props}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 dark:text-indigo-400 hover:underline"
              />
            );
          },
          table(props) {
            return (
              <div className="overflow-x-auto">
                <table
                  {...props}
                  className="text-xs border-collapse"
                />
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Detect dark mode via the `dark` class on <html>, which is what tailwind's
 * `darkMode: 'class'` uses. Falls back to prefers-color-scheme.
 */
function useIsDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof document === 'undefined') return false;
    return document.documentElement.classList.contains('dark');
  });
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const mo = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains('dark'));
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

import { useMemo, useState, type ReactNode } from 'react';
import { Modal, Input, Spin, Empty } from '@arco-design/web-react';

// ============================================================
// EntityPicker — one list/picker primitive for every entity
// ============================================================
// The console keeps needing "pick an agent / a session / a machine / a skill"
// from many places (schedule a wake, install a skill onto an agent, …). Before
// this, each page rolled its own — or worse, made the operator TYPE an id. This
// is the single source of that interaction: a searchable card list, driven by a
// small per-entity config (a query hook + how to render/identify a row). Mount
// it inline, or use EntityPickerField for a "click to choose" form control.
//
// The API still speaks ids — CLI and agents pass ids directly, which is faster
// for them. This is purely the *human* affordance: never make a person remember
// an id they could pick from a list.

export interface EntityPickerConfig<T> {
  /** TanStack Query hook returning the candidate rows. */
  useList: () => { data?: T[]; isLoading?: boolean; error?: unknown };
  /** Stable id for a row — the value handed back on select. */
  getId: (item: T) => string;
  /** Primary line (defaults to the id). */
  getLabel?: (item: T) => ReactNode;
  /** Secondary line under the label (optional). */
  getHint?: (item: T) => ReactNode;
  /** A small badge/right-aligned chip (optional). */
  getBadge?: (item: T) => ReactNode;
  /** Lowercased haystack for the search box (defaults to id). */
  getSearchText?: (item: T) => string;
  /**
   * Grey out + block selection for a row (e.g. cross-family models when a
   * session is locked to one protocol family). Disabled rows still render so
   * the user sees why a choice is unavailable.
   */
  isDisabled?: (item: T) => boolean;
  /** Tooltip/hint shown on a disabled row explaining why it can't be picked. */
  disabledHint?: (item: T) => string;
  placeholder?: string;
  emptyText?: string;
}

/**
 * The inline picker: a search box over a scrollable card list. Calls onPick
 * with the row's id (and the row) when one is clicked. `value` highlights the
 * current selection. Generic over the row type T.
 */
export function EntityPicker<T>({
  config,
  value,
  onPick,
  maxHeight = 320,
}: {
  config: EntityPickerConfig<T>;
  value?: string | null;
  onPick: (id: string, item: T) => void;
  maxHeight?: number;
}) {
  const { data, isLoading, error } = config.useList();
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const all = data ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    const search = config.getSearchText ?? ((i: T) => config.getId(i).toLowerCase());
    return all.filter((i) => search(i).includes(needle));
  }, [data, q, config]);

  return (
    <div>
      <Input.Search
        allowClear
        value={q}
        onChange={setQ}
        placeholder={config.placeholder ?? '搜索…'}
        size="small"
        className="mb-2"
      />
      <div style={{ maxHeight, overflowY: 'auto' }} className="flex flex-col gap-1.5 pr-0.5">
        {error ? (
          <div className="text-sm py-6 text-center" style={{ color: 'rgb(var(--red-6))' }}>
            {error instanceof Error ? error.message : String(error)}
          </div>
        ) : isLoading && !data ? (
          <div className="flex justify-center py-8"><Spin /></div>
        ) : rows.length === 0 ? (
          <Empty description={config.emptyText ?? (q ? '没有匹配项' : '空')} />
        ) : (
          rows.map((item) => {
            const id = config.getId(item);
            const on = id === value;
            const disabled = config.isDisabled?.(item) ?? false;
            const hint = disabled ? config.disabledHint?.(item) : undefined;
            return (
              <button
                key={id}
                disabled={disabled}
                title={hint}
                onClick={() => { if (!disabled) onPick(id, item); }}
                className="text-left rounded-md p-2.5 transition-all"
                style={{
                  border: on ? '2px solid rgb(var(--arcoblue-6))' : '1px solid var(--color-border-2)',
                  background: on ? 'var(--color-fill-1)' : 'var(--color-bg-2)',
                  opacity: disabled ? 0.45 : 1,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm" style={{ color: 'var(--color-text-1)' }}>
                      {config.getLabel ? config.getLabel(item) : <code className="font-mono text-xs">{id}</code>}
                    </div>
                    {(hint || config.getHint) && (
                      <div className="truncate text-xs mt-0.5" style={{ color: hint ? 'rgb(var(--orange-6))' : 'var(--color-text-3)' }}>
                        {hint ?? (config.getHint ? config.getHint(item) : null)}
                      </div>
                    )}
                  </div>
                  {config.getBadge && <div className="shrink-0">{config.getBadge(item)}</div>}
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/**
 * A form control that shows the chosen id (or a placeholder) as a button; click
 * to open the EntityPicker in a modal and choose. This is what replaces a bare
 * "type the id" <Input> on a form — same data, but the human picks from a list.
 * Pass `clearable` to allow unselecting (for optional fields).
 */
export function EntityPickerField<T>({
  config,
  value,
  onChange,
  title,
  placeholder = '点击选择…',
  clearable,
}: {
  config: EntityPickerConfig<T>;
  value: string | null;
  onChange: (id: string | null) => void;
  title: string;
  placeholder?: string;
  clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(true)}
          className="flex-1 text-left rounded-md px-3 py-2 transition-all"
          style={{ border: '1px solid var(--color-border-2)', background: 'var(--color-bg-2)' }}
        >
          {value
            ? <code className="font-mono text-sm" style={{ color: 'var(--color-text-1)' }}>{value}</code>
            : <span className="text-sm" style={{ color: 'var(--color-text-4)' }}>{placeholder}</span>}
        </button>
        {clearable && value && (
          <button
            onClick={() => onChange(null)}
            className="text-xs px-2 py-1"
            style={{ color: 'var(--color-text-3)' }}
          >清除</button>
        )}
      </div>
      {open && (
        <Modal
          visible
          title={title}
          onCancel={() => setOpen(false)}
          footer={null}
          style={{ width: 560 }}
        >
          <EntityPicker
            config={config}
            value={value}
            onPick={(id) => { onChange(id); setOpen(false); }}
          />
        </Modal>
      )}
    </>
  );
}

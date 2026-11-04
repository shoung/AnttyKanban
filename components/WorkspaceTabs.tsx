export type WorkspaceKind = 'boards' | 'maps' | 'calendar' | 'agents';
export default function WorkspaceTabs({
  value,
  dirty = false,
  busy = false,
  onChange,
}: {
  value: WorkspaceKind;
  dirty?: boolean;
  busy?: boolean;
  onChange: (value: WorkspaceKind) => void;
}) {
  const select = (next: WorkspaceKind) => {
    if (busy || next === value) return;
    if (dirty && !window.confirm('這個工作區有尚未儲存的內容。確定離開並捨棄嗎？')) return;
    onChange(next);
  };
  return (
    <nav
      aria-label="工作區"
      className="h-[60px] flex items-center gap-2 px-4 border-b border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700 overflow-x-auto"
    >
      <span className="font-bold mr-3 whitespace-nowrap">🐜 Antty</span>
      {(
        [
          ['boards', '看板'],
          ['maps', '心智圖'],
          ['calendar', '日曆'],
          ['agents', 'AI 接入'],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          type="button"
          aria-current={value === key ? 'page' : undefined}
          disabled={busy}
          onClick={() => select(key)}
          className={`px-4 py-2 rounded-lg whitespace-nowrap text-sm ${value === key ? 'bg-blue-100 text-blue-800' : 'text-slate-600 hover:bg-slate-100'} disabled:opacity-40`}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

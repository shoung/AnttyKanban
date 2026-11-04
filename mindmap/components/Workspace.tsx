/* eslint-disable react-hooks/refs -- Imperative editor handlers intentionally read the latest document ref on interaction, never as render output. */
'use client';
import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  type NodeProps,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  RefreshCw,
  Plus,
  Search,
  ChevronRight,
  ChevronDown,
  ArrowUpRight,
  PanelLeftClose,
  PanelLeftOpen,
  Download,
  Upload,
  Undo2,
  Redo2,
  Maximize,
  Trash2,
  GitBranch,
  Leaf,
  Command,
  LogIn,
  Check,
  Cloud,
  AlertCircle,
  X,
} from 'lucide-react';
import { parseMarkdown, toMarkdown } from '../lib/model';

import {
  type Tree,
  uid,
  walk,
  find,
  parentOf,
  update,
  remove,
  move,
  layout,
  example,
} from './tree';
type Doc = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  root: Tree;
};
type Summary = Omit<Doc, 'root'>;
type NodeData = {
  text: string;
  depth: number;
  branch: number;
  childCount: number;
  collapsed: boolean;
  onText: (id: string, text: string) => void;
  onToggle: (id: string) => void;
  editing: boolean;
  onEdit: (id: string | null) => void;
};
const EMPTY_NOTICE = '標題與節點不能留空；輸入中的內容會保留，填好後會自動儲存。';
const palette = ['#7c79d9', '#bc805b', '#5d9e91', '#b679a2', '#7497c6'];
const MapNode = memo(function MapNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const [draft, setDraft] = useState(data.text);
  useEffect(() => setDraft(data.text), [data.text]);
  const commit = () => {
    const t = draft.trim();
    data.onText(id, t || '未命名想法');
    data.onEdit(null);
  };
  return (
    <div
      className={`mind-node ${data.depth === 0 ? 'root-node' : ''} ${selected ? 'node-selected' : ''}`}
      style={
        {
          '--branch-color': palette[data.branch % palette.length],
        } as React.CSSProperties
      }
      onDoubleClick={() => data.onEdit(id)}
    >
      <Handle type="target" position={Position.Left} />
      {data.editing ? (
        <textarea
          autoFocus
          maxLength={2000}
          aria-label="編輯節點"
          className="nodrag nowheel"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            data.onText(id, e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') {
              setDraft(data.text);
              data.onEdit(null);
            }
          }}
        />
      ) : (
        <span title={data.text}>{data.text}</span>
      )}
      {data.childCount > 0 && (
        <button
          className="collapse nodrag"
          aria-label={data.collapsed ? '展開分支' : '收合分支'}
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle(id);
          }}
        >
          {data.collapsed ? data.childCount : <ChevronDown size={12} />}
        </button>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});
const nodeTypes = { mind: MapNode };
function Button({
  children,
  label,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      className="icon-btn"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!r.ok) {
    let error;
    try {
      error = await r.json();
    } catch {
      /* Non-JSON error responses use the status fallback. */
    }
    throw new Error(
      r.status === 401
        ? '請先登入你的 Google 帳號'
        : r.status === 409
          ? '這張圖已被其他視窗或 AI 更新。請先匯出你的版本，再重新開啟。'
          : error?.error || `請求失敗 (${r.status})`,
    );
  }
  return r.json();
}
function download(name: string, content: string, type: string) {
  const u = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
export type MapApi = <T>(url: string, init?: RequestInit) => Promise<T>;
export type WorkspaceProps = {
  request?: MapApi;
  onLogin?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
};
function Studio({ request = api, onLogin = () => {}, onDirtyChange }: WorkspaceProps) {
  const flow = useReactFlow();
  const [maps, setMaps] = useState<Summary[]>([]);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [sidebar, setSidebar] = useState(false);
  const [help, setHelp] = useState(false);
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [history, setHistory] = useState<Tree[]>([]);
  const [future, setFuture] = useState<Tree[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});
  const current = useRef(doc);
  current.current = doc;
  const editVersion = useRef(0);
  const savingRef = useRef(false);
  useEffect(() => {
    onDirtyChange?.(dirty || saving);
    return () => onDirtyChange?.(false);
  }, [dirty, saving, onDirtyChange]);
  const file = useRef<HTMLInputElement>(null);
  const switching = useRef(false);
  const refresh = useCallback(async () => {
    const r = await request<{ maps: Summary[] }>('/api/maps');
    setMaps(r.maps);
  }, [request]);
  useEffect(() => {
    setSidebar(window.innerWidth > 760);
    refresh()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [refresh, request]);
  const change = useCallback((fn: (root: Tree) => Tree) => {
    const d = current.current;
    if (!d) return;
    const next = fn(d.root);
    if (next === d.root) return;
    setHistory((h) => [...h.slice(-59), d.root]);
    setFuture([]);
    editVersion.current++;
    setDirty(true);
    const updated = { ...d, root: next };
    current.current = updated;
    setDoc(updated);
  }, []);
  const rename = useCallback(
    (id: string, text: string) => {
      if (current.current && find(current.current.root, id)?.text === text) return;
      setError('');
      change((root) => update(root, id, (n) => ({ ...n, text })));
    },
    [change],
  );
  const beginEditing = useCallback((id: string | null) => {
    if (id !== null) editVersion.current++;
    setEditing(id);
  }, []);
  const toggle = useCallback(
    (id: string) =>
      setCollapsed((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    [],
  );
  const save = useCallback(async () => {
    const d = current.current;
    if (!d || savingRef.current || switching.current) return;
    if (!d.title.trim() || walk(d.root).some((n) => !n.text.trim())) {
      setNotice(EMPTY_NOTICE);
      return;
    }
    const version = editVersion.current;
    savingRef.current = true;
    setSaving(true);
    setStatus('儲存中');
    try {
      const saved = await request<Doc>(`/api/maps/${d.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: d.title,
          root: d.root,
          expectedRevision: d.revision,
        }),
      });
      setDoc((now) =>
        now?.id === d.id ? { ...now, revision: saved.revision, updatedAt: saved.updatedAt } : now,
      );
      if (editVersion.current === version) setDirty(false);
      setStatus('已儲存');
      setNotice((previous) => (previous === EMPTY_NOTICE ? '' : previous));
      setError('');
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setStatus('尚未儲存');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [refresh, request]);
  useEffect(() => {
    if (!dirty || saving || loading || error) return;
    const t = setTimeout(() => void save(), 900);
    return () => clearTimeout(t);
  }, [doc, dirty, saving, loading, error, save]);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);
  const open = async (id: string) => {
    if (switching.current || savingRef.current) return;
    if (dirty && !window.confirm('有尚未儲存的修改。要放棄修改並切換嗎？')) return;
    switching.current = true;
    const startedVersion = editVersion.current;
    const startedId = current.current?.id;
    setNotice('');
    setLoading(true);
    try {
      const d = await request<Doc>(`/api/maps/${id}`);
      if (editVersion.current !== startedVersion || current.current?.id !== startedId) {
        setNotice('讀取期間有新的編輯，已保留目前內容。需要時可再次重新讀取。');
        return;
      }
      current.current = d;
      setDoc(d);
      setSelected(d.root.id);
      setHistory([]);
      setFuture([]);
      setCollapsed(new Set());
      setDirty(false);
      setError('');
      setStatus('已儲存');
      setDragged({});
      setTimeout(() => flow.fitView({ padding: 0.3, duration: 400 }), 100);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      switching.current = false;
      setLoading(false);
    }
  };
  const create = async (title: string, root?: Tree) => {
    if (savingRef.current || switching.current) return;
    if (dirty && !window.confirm('有尚未儲存的修改。要放棄修改並新增嗎？')) return;
    switching.current = true;
    const startedVersion = editVersion.current;
    const startedId = current.current?.id;
    setNotice('');
    setLoading(true);
    try {
      const d = await request<Doc>('/api/maps', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim() || '未命名心智圖',
          root: root || {
            id: uid(),
            text: title.trim() || '新的想法',
            children: [],
          },
        }),
      });
      if (editVersion.current !== startedVersion || current.current?.id !== startedId) {
        setNotice('新圖已建立並加入清單；目前編輯已保留，沒有自動切換。');
        setNewTitle(null);
        await refresh();
        return;
      }
      current.current = d;
      setDoc(d);
      setSelected(d.root.id);
      setHistory([]);
      setFuture([]);
      setCollapsed(new Set());
      setDirty(false);
      setError('');
      setStatus('已儲存');
      setNewTitle(null);
      await refresh();
      setTimeout(() => flow.fitView({ padding: 0.4, duration: 400 }), 100);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      switching.current = false;
      setLoading(false);
    }
  };
  const add = useCallback(
    (sibling = false) => {
      if (!doc) return;
      const id = uid();
      const target = sibling
        ? parentOf(doc.root, selected || '')?.id
        : selected && find(doc.root, selected)
          ? selected
          : doc.root.id;
      if (!target) return;
      change((root) =>
        update(root, target, (n) => ({
          ...n,
          children: [...n.children, { id, text: '新的想法', children: [] }],
        })),
      );
      setCollapsed((s) => {
        const n = new Set(s);
        n.delete(target);
        return n;
      });
      setSelected(id);
      setEditing(id);
    },
    [doc, selected, change],
  );
  const del = useCallback(() => {
    if (!doc || !selected || selected === doc.root.id) return;
    const n = find(doc.root, selected);
    if (n?.children.length && !window.confirm(`刪除「${n.text}」及其所有子節點？可以復原。`))
      return;
    const p = parentOf(doc.root, selected);
    change((root) => remove(root, selected));
    setSelected(p?.id || null);
  }, [doc, selected, change]);
  const undo = useCallback(() => {
    if (!doc || !history.length) return;
    setFuture((f) => [doc.root, ...f]);
    setDoc({ ...doc, root: history[history.length - 1] });
    setHistory((h) => h.slice(0, -1));
    editVersion.current++;
    setDirty(true);
  }, [doc, history]);
  const redo = useCallback(() => {
    if (!doc || !future.length) return;
    setHistory((h) => [...h, doc.root]);
    setDoc({ ...doc, root: future[0] });
    setFuture((f) => f.slice(1));
    editVersion.current++;
    setDirty(true);
  }, [doc, future]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (
        (e.target as HTMLElement).closest('input,textarea,[contenteditable=true]') ||
        newTitle !== null
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        void save();
      } else if (doc && e.key === 'Tab') {
        e.preventDefault();
        add();
      } else if (doc && e.key === 'Enter') {
        e.preventDefault();
        add(true);
      } else if (doc && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        del();
      } else if (e.key === 'F2' && selected) {
        e.preventDefault();
        setEditing(selected);
      } else if (e.key === 'Escape') {
        setEditing(null);
        setHelp(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [doc, selected, add, del, undo, redo, save, newTitle]);
  const positions = useMemo(
    () => (doc ? layout(doc.root, collapsed) : new Map()),
    [doc, collapsed],
  );
  const nodes: Node<NodeData>[] = useMemo(
    () =>
      doc
        ? walk(doc.root)
            .filter((n) => positions.has(n.id))
            .map((n) => {
              const p = positions.get(n.id)!;
              return {
                id: n.id,
                type: 'mind',
                position: dragged[n.id] || { x: p.x, y: p.y },
                selected: selected === n.id,
                data: {
                  text: n.text,
                  depth: p.depth,
                  branch: p.branch,
                  childCount: n.children.length,
                  collapsed: collapsed.has(n.id),
                  onText: rename,
                  onToggle: toggle,
                  editing: editing === n.id,
                  onEdit: beginEditing,
                },
              };
            })
        : [],
    [doc, positions, selected, collapsed, rename, toggle, editing, beginEditing, dragged],
  );
  const edges: Edge[] = useMemo(
    () =>
      doc
        ? walk(doc.root).flatMap((n) =>
            n.children
              .filter((c) => positions.has(c.id) && positions.has(n.id))
              .map((c) => ({
                id: `${n.id}-${c.id}`,
                source: n.id,
                target: c.id,
                type: 'smoothstep',
                style: {
                  stroke: palette[positions.get(c.id)!.branch % palette.length],
                  strokeWidth: 2,
                  opacity: 0.65,
                },
              })),
          )
        : [],
    [doc, positions],
  );
  const importFile = async (f: File) => {
    try {
      if (f.size > 1024 * 1024) throw new Error('檔案請小於 1 MB');
      const text = await f.text();
      const parsed = f.name.endsWith('.md') ? parseMarkdown(text) : JSON.parse(text);
      const root = parsed.root || parsed;
      await create(parsed.title || f.name.replace(/\.json$/, ''), root);
    } catch (e) {
      setError(`匯入失敗：${(e as Error).message}`);
    }
  };
  return (
    <div className="workspace">
      {sidebar && (
        <aside className="sidebar">
          <a className="brand" href="/">
            <span className="brand-mark">
              <GitBranch size={23} />
            </span>
            <span>
              Antty <small>心智圖工作區</small>
            </span>
          </a>
          <div className="personal">
            <span className="avatar">我</span>
            <div>
              我的思考空間<small>PRIVATE WORKSPACE</small>
            </div>
            <span className="private-dot" />
          </div>
          <button className="new-map" onClick={() => setNewTitle('')}>
            <Plus size={17} /> 建立心智圖 <kbd>＋</kbd>
          </button>
          <label className="search">
            <Search size={15} />
            <input
              placeholder="搜尋你的想法…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <div className="section-label">
            我的心智圖 <span>{maps.length}</span>
          </div>
          <nav className="map-list">
            {maps
              .filter((m) => m.title.toLowerCase().includes(search.toLowerCase()))
              .map((m) => (
                <button
                  key={m.id}
                  className={`map-item ${doc?.id === m.id ? 'active' : ''}`}
                  onClick={() => void open(m.id)}
                >
                  <GitBranch size={17} />
                  <span>
                    {m.title}
                    <small>
                      {new Date(m.updatedAt).toLocaleDateString('zh-TW', {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </small>
                  </span>
                  {doc?.id === m.id && <span className="active-dot" />}
                </button>
              ))}
            {!maps.length && !loading && (
              <p className="empty-list">
                還沒有心智圖。
                <br />
                從一個小小的想法開始吧。
              </p>
            )}
          </nav>
          <div className="sidebar-bottom">
            <Leaf size={17} />
            <span>留一點空間，給下一個想法。</span>
          </div>
          <button className="help-btn" onClick={() => setHelp(true)}>
            <Command size={16} /> 快捷鍵與 AI 接入 <ArrowUpRight size={14} />
          </button>
        </aside>
      )}
      <main>
        <header>
          <div className="breadcrumb">
            <Button label={sidebar ? '收起側欄' : '展開側欄'} onClick={() => setSidebar(!sidebar)}>
              {sidebar ? <PanelLeftClose size={19} /> : <PanelLeftOpen size={19} />}
            </Button>
            <span className="crumb">我的心智圖</span>
            <ChevronRight size={13} />
            {doc ? (
              <input
                aria-label="心智圖名稱"
                maxLength={200}
                className="title-input"
                value={doc.title}
                onChange={(e) => {
                  editVersion.current++;
                  setDirty(true);
                  setError('');
                  const updated = { ...doc, title: e.target.value };
                  current.current = updated;
                  setDoc(updated);
                }}
              />
            ) : (
              <strong>歡迎回來</strong>
            )}
          </div>
          <div className="header-right">
            {doc && (
              <Button
                label="重新讀取最新版本（含 AI 修改）"
                onClick={() => void open(doc.id)}
                disabled={saving}
              >
                <RefreshCw size={16} />
              </Button>
            )}
            {doc && (
              <span className={`save-status ${dirty ? 'pending' : ''}`}>
                {saving ? (
                  <Cloud size={14} />
                ) : dirty ? (
                  <span className="pending-dot" />
                ) : (
                  <Check size={14} />
                )}
                <span>{dirty && !saving ? '等待儲存' : status}</span>
              </span>
            )}
            <div className="export-wrap">
              <button
                className="export-btn"
                onClick={() => setExportOpen(!exportOpen)}
                disabled={!doc}
              >
                <Download size={15} />
                <span>匯出</span>
                <ChevronDown size={12} />
              </button>
              {exportOpen && doc && (
                <div className="menu">
                  <button
                    onClick={() => {
                      download(
                        `${doc.title}.json`,
                        JSON.stringify(doc, null, 2),
                        'application/json',
                      );
                      setExportOpen(false);
                    }}
                  >
                    JSON · 完整資料
                  </button>
                  <button
                    onClick={() => {
                      download(`${doc.title}.md`, toMarkdown(doc), 'text/markdown');
                      setExportOpen(false);
                    }}
                  >
                    Markdown · 文字大綱
                  </button>
                </div>
              )}
            </div>
            <button className="user-avatar" title="以 Google 登入" onClick={() => onLogin()}>
              我
            </button>
          </div>
        </header>
        {notice && (
          <div role="status" className="error-banner">
            <span>{notice}</span>
            <button onClick={() => setNotice('')}>關閉</button>
          </div>
        )}
        {error && (
          <div className="error-banner">
            <AlertCircle size={17} />
            <span>{error}</span>
            {error.includes('登入') ? (
              <button onClick={() => onLogin()}>
                Google 登入 <LogIn size={14} />
              </button>
            ) : (
              <button
                onClick={() => {
                  setError('');
                  if (dirty) void save();
                  else void refresh();
                }}
              >
                重試
              </button>
            )}
          </div>
        )}
        <section className="canvas">
          {doc ? (
            <>
              <div className="canvas-label">
                <span className="canvas-tag">腦力激盪</span>
                <h1>{doc.title || '未命名心智圖'}</h1>
                <p>讓每一個想法，都有長出分支的空間。</p>
              </div>
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                onNodeClick={(_, n) => setSelected(n.id)}
                onPaneClick={() => setSelected(null)}
                onNodeDrag={(_, n) => setDragged((p) => ({ ...p, [n.id]: n.position }))}
                onNodeDragStop={(_, n) => {
                  const center = {
                    x: n.position.x + 100,
                    y: n.position.y + 25,
                  };
                  const target = nodes
                    .filter((t) => t.id !== n.id)
                    .map((t) => ({
                      id: t.id,
                      d: Math.hypot(t.position.x + 100 - center.x, t.position.y + 25 - center.y),
                    }))
                    .sort((a, b) => a.d - b.d)[0];
                  if (target && target.d < 150) change((root) => move(root, n.id, target.id));
                  setDragged({});
                }}
                fitView
                fitViewOptions={{ padding: 0.35, maxZoom: 1 }}
                minZoom={0.15}
                maxZoom={2}
                deleteKeyCode={null}
                selectionKeyCode={null}
                nodesConnectable={false}
                panOnScroll
                zoomOnDoubleClick={false}
                proOptions={{ hideAttribution: false }}
              >
                <Background color="#deded8" gap={22} size={1} />
                <Controls showInteractive={false} />
                <MiniMap
                  nodeColor={(n) => palette[(n.data as NodeData).branch % palette.length]}
                  maskColor="rgba(247,248,245,.78)"
                  zoomable
                  pannable
                />
              </ReactFlow>
              <div className="floating-toolbar">
                <button className="add-primary" onClick={() => add()}>
                  <Plus size={16} /> 子節點 <kbd>Tab</kbd>
                </button>
                <Button
                  label="新增同層節點 (Enter)"
                  onClick={() => add(true)}
                  disabled={!selected || selected === doc.root.id}
                >
                  <GitBranch size={18} />
                </Button>
                <span className="divider" />
                <Button label="復原 (Ctrl/⌘ Z)" onClick={undo} disabled={!history.length}>
                  <Undo2 size={18} />
                </Button>
                <Button label="重做 (Ctrl/⌘ Shift Z)" onClick={redo} disabled={!future.length}>
                  <Redo2 size={18} />
                </Button>
                <span className="divider" />
                <Button
                  label="置中畫布"
                  onClick={() => flow.fitView({ padding: 0.3, duration: 400 })}
                >
                  <Maximize size={17} />
                </Button>
                <Button
                  label="刪除選取節點"
                  onClick={del}
                  disabled={!selected || selected === doc.root.id}
                >
                  <Trash2 size={17} />
                </Button>
              </div>
              <div className="canvas-footer">
                <span>
                  <span className="live-dot" />
                  {walk(doc.root).length} 個想法 · {nodes.length} 個可見
                </span>
                <span>雙擊編輯 · 拖到另一節點附近即可移動分支</span>
              </div>
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-art">
                <GitBranch size={45} />
                <span className="orbit one" />
                <span className="orbit two" />
              </div>
              <span className="eyebrow">A LITTLE ROOM FOR BIG IDEAS</span>
              <h1>好想法，從一個分支開始。</h1>
              <p>
                把腦中的零散靈感放在一起。
                <br />
                慢慢連結、展開，找到下一步的方向。
              </p>
              <div className="welcome-actions">
                <button className="primary" onClick={() => setNewTitle('')}>
                  <Plus size={17} /> 建立第一張心智圖
                </button>
                <button
                  className="secondary"
                  onClick={() => void create('我的第一場腦力激盪', example())}
                >
                  試試範例 <ArrowUpRight size={16} />
                </button>
              </div>
              <button className="import-link" onClick={() => file.current?.click()}>
                <Upload size={15} /> 匯入 JSON / Markdown 心智圖
              </button>
            </div>
          )}
        </section>
        <input
          ref={file}
          type="file"
          accept=".json,.md,application/json,text/markdown"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
            e.target.value = '';
          }}
        />
        {doc && (
          <button
            className="import-floating"
            title="匯入 JSON / Markdown 為新圖"
            aria-label="匯入 JSON / Markdown 為新圖"
            onClick={() => file.current?.click()}
          >
            <Upload size={16} />
          </button>
        )}
      </main>
      {newTitle !== null && (
        <div className="modal-backdrop" onClick={() => setNewTitle(null)}>
          <form
            className="modal"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void create(newTitle);
            }}
          >
            <button
              type="button"
              className="modal-close icon-btn"
              aria-label="關閉"
              onClick={() => setNewTitle(null)}
            >
              <X size={18} />
            </button>
            <span className="modal-icon">
              <GitBranch size={24} />
            </span>
            <h2>今天，想探索什麼？</h2>
            <p>給這張心智圖一個名字，隨時都可以修改。</p>
            <input
              autoFocus
              required
              maxLength={120}
              placeholder="例如：新遊戲的可能性"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
            <button className="primary" disabled={loading} type="submit">
              {loading ? '建立中…' : '開始發想'} <ArrowUpRight size={16} />
            </button>
          </form>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close icon-btn"
              aria-label="關閉"
              onClick={() => setHelp(false)}
            >
              <X size={18} />
            </button>
            <h2>把注意力，留給想法。</h2>
            <p>常用操作</p>
            <dl>
              <dt>新增子節點</dt>
              <dd>Tab</dd>
              <dt>新增同層節點</dt>
              <dd>Enter</dd>
              <dt>編輯文字</dt>
              <dd>雙擊 / F2</dd>
              <dt>復原 / 重做</dt>
              <dd>Ctrl/⌘ Z / Shift Z</dd>
              <dt>刪除分支</dt>
              <dd>Delete</dd>
              <dt>移動分支</dt>
              <dd>拖近另一個節點</dd>
            </dl>
            <h3>與 AI 一起發想</h3>
            <p>
              本專案提供 /api/mcp 端點。在「AI 接入」頁面建立有期限的個人權杖後，可在支援 Bearer
              token 的 MCP 客戶端連接。所有修改使用版本檢查，避免覆蓋彼此的內容。
            </p>
            <p className="fine-print">
              權杖只能存取你授權的工作區，隨時可在「AI 接入」撤銷。請勿把權杖貼到對話或公開文件。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
export default function Workspace(props: WorkspaceProps) {
  return (
    <ReactFlowProvider>
      <Studio {...props} />
    </ReactFlowProvider>
  );
}

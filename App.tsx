import React, { useState, useEffect, useMemo } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import {
  Plus,
  Moon,
  Sun,
  Trash2,
  Layout,
  PenLine,
  FolderOpen,
  LogOut,
  LogIn,
  Loader2,
  AlertCircle,
  Copy,
  HelpCircle,
} from 'lucide-react';
import { Column, Task, Project } from './types';
import { KanbanColumn } from './components/KanbanColumn';
import { TaskCard } from './components/TaskCard';
import { TaskModal } from './components/TaskModal';
import { Button } from './components/Button';
import { auth, db, googleProvider } from './firebase';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';

// Initial Data Generators
const createInitialColumns = (): Column[] => [
  { id: `c1-${Date.now()}`, title: '預備', color: '#64748b' },
  { id: `c2-${Date.now()}`, title: '執行中', color: '#3b82f6' },
  { id: `c3-${Date.now()}`, title: '待審核', color: '#eab308' },
  { id: `c4-${Date.now()}`, title: '待進行', color: '#f97316' },
  { id: `c5-${Date.now()}`, title: '完成', color: '#22c55e' },
];

const getToday = () => new Date().toISOString().split('T')[0];
const getTomorrow = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
};

const sortTasks = (tasksToSort: Task[]) =>
  [...tasksToSort].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

const normalizeTask = (task: Task): Task => ({
  ...task,
  tags: Array.isArray(task.tags) ? task.tags : [],
  comments: Array.isArray(task.comments) ? task.comments : [],
});

const normalizeTaskOrders = (tasksToNormalize: Task[]): Task[] => {
  const normalizedTasks = tasksToNormalize.map(normalizeTask);
  const grouped = normalizedTasks.reduce<Record<string, Task[]>>((acc, task) => {
    acc[task.columnId] = [...(acc[task.columnId] || []), task];
    return acc;
  }, {});

  const normalizedById = new Map<string, Task>();
  Object.values(grouped).forEach((columnTasks) => {
    sortTasks(columnTasks).forEach((task, index) => {
      normalizedById.set(task.id, { ...task, order: index });
    });
  });

  return normalizedTasks.map((task) => normalizedById.get(task.id) || { ...task, order: 0 });
};

const normalizeProjects = (projectsToNormalize: Project[]): Project[] =>
  projectsToNormalize.map((project) => ({
    ...project,
    tasks: normalizeTaskOrders(project.tasks),
  }));

const isFirebaseError = (error: unknown): error is { code?: string; message?: string } =>
  typeof error === 'object' && error !== null && ('code' in error || 'message' in error);

const getTaskColumnId = (taskId: string, taskList: Task[]) =>
  taskList.find((task) => task.id === taskId)?.columnId;

const EMPTY_COLUMNS: Column[] = [];
const EMPTY_TASKS: Task[] = [];

const INITIAL_PROJECTS: Project[] = [
  {
    id: 'p1',
    name: '產品開發專案',
    columns: [
      { id: 'c1', title: '預備', color: '#64748b' },
      { id: 'c2', title: '執行中', color: '#3b82f6' },
      { id: 'c3', title: '待審核', color: '#eab308' },
      { id: 'c4', title: '待進行', color: '#f97316' },
      { id: 'c5', title: '完成', color: '#22c55e' },
    ],
    tasks: [
      {
        id: 't1',
        title: '專案啟動會議',
        startDate: getToday(),
        endDate: getTomorrow(),
        manDays: 0.5,
        tags: ['會議', '管理'],
        assignee: 'Alice',
        columnId: 'c1',
        order: 0,
        icon: '📢',
        comments: [],
      },
      {
        id: 't2',
        title: 'UI 設計草稿',
        startDate: getToday(),
        endDate: getToday(),
        manDays: 2,
        tags: ['設計', 'Figma'],
        assignee: 'Bob',
        columnId: 'c2',
        order: 0,
        icon: '🎨',
        comments: [],
      },
    ],
  },
];

const TEAM_BOARD_ID = 'default';
const getBoardDocRef = () => doc(db, 'boards', TEAM_BOARD_ID);

const App: React.FC = () => {
  // --- Auth & Data State ---
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);
  const [loginError, setLoginError] = useState<{
    title: string;
    message: string;
    code?: string;
    details?: string;
  } | null>(null);

  // --- App State ---
  const [projects, setProjects] = useState<Project[]>(() => normalizeProjects(INITIAL_PROJECTS));
  const [activeProjectId, setActiveProjectId] = useState<string>(INITIAL_PROJECTS[0].id);
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Modals & UI State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [activeColumnForNewTask, setActiveColumnForNewTask] = useState<string>('');
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [editingProjectNameId, setEditingProjectNameId] = useState<string | null>(null);

  // Drag State
  const [activeDragTaskId, setActiveDragTaskId] = useState<string | null>(null);

  // Derived State
  const activeProject = projects.find((p) => p.id === activeProjectId) || projects[0];
  const columns = activeProject?.columns || EMPTY_COLUMNS;
  const tasks = activeProject?.tasks || EMPTY_TASKS;
  const sortedTasks = useMemo(() => sortTasks(tasks), [tasks]);
  const activeDragTask = activeDragTaskId
    ? tasks.find((task) => task.id === activeDragTaskId) || null
    : null;
  const columnIds = useMemo(() => new Set(columns.map((column) => column.id)), [columns]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // --- Theme Effect ---
  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  // --- Auth Listener ---
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
      if (currentUser) {
        setDataLoading(true);
        setLoginError(null); // Clear errors on success
      }
    });
    return () => unsubscribe();
  }, []);

  // --- Firestore Sync (Read) ---
  useEffect(() => {
    if (!user) {
      // If no user, we might want to keep local default data or clear it.
      // For now, let's keep INITIAL_PROJECTS so they see something before logging in.
      return;
    }

    const boardDocRef = getBoardDocRef();
    const unsubscribe = onSnapshot(
      boardDocRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data.projects && Array.isArray(data.projects)) {
            const normalizedProjects = normalizeProjects(data.projects as Project[]);
            setProjects(normalizedProjects);
            // If the currently active project was deleted remotely, switch to the first available
            setActiveProjectId((prev) => {
              const stillExists = data.projects.find((p: Project) => p.id === prev);
              return stillExists ? prev : data.projects[0]?.id || '';
            });
          }
        } else {
          // Initialize shared team board data
          setDoc(
            boardDocRef,
            {
              projects: normalizeProjects(INITIAL_PROJECTS),
              updatedAt: new Date().toISOString(),
              updatedBy: user.uid,
            },
            { merge: true },
          );
        }
        setDataLoading(false);
      },
      (error) => {
        console.error('Error fetching data:', error);
        setDataLoading(false);
      },
    );

    return () => unsubscribe();
  }, [user]);

  // --- Data Persistence Helper ---
  // We use this wrapper to update state AND write to Firestore
  // Note: We only write if user is logged in.
  const updateProjects = async (newProjects: Project[]) => {
    const normalizedProjects = normalizeProjects(newProjects);
    setProjects(normalizedProjects);
    if (user) {
      try {
        await setDoc(
          getBoardDocRef(),
          {
            projects: normalizedProjects,
            updatedAt: new Date().toISOString(),
            updatedBy: user.uid,
          },
          { merge: true },
        );
      } catch (e) {
        console.error('Error saving to Firestore', e);
      }
    }
  };

  // --- Auth Actions ---
  const handleLogin = async () => {
    setLoginError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error: unknown) {
      const errorCode = isFirebaseError(error) ? error.code : undefined;
      const errorMessage = isFirebaseError(error) ? error.message : '發生未知錯誤';
      console.error('Login failed detailed:', error);

      let errorData = {
        title: '登入失敗',
        message: errorMessage || '發生未知錯誤',
        code: errorCode,
        details: '',
      };

      if (errorCode === 'auth/unauthorized-domain') {
        const currentHost = window.location.hostname;
        const currentHref = window.location.href;

        errorData = {
          title: '網域未授權 (Unauthorized Domain)',
          message: 'Firebase 拒絕了此請求，因為目前的網域不在白名單中。',
          code: errorCode,
          details: `偵測到的 Host: "${currentHost || '空白 (Sandbox 環境)'}"\n完整網址: "${currentHref}"`,
        };
      } else if (errorCode === 'auth/popup-blocked') {
        errorData = {
          title: '彈跳視窗被封鎖',
          message: '請允許瀏覽器顯示彈跳視窗以進行登入。',
          code: errorCode,
          details: '',
        };
      } else if (errorCode === 'auth/popup-closed-by-user') {
        errorData = {
          title: '登入取消',
          message: '您關閉了登入視窗。',
          code: errorCode,
          details: '',
        };
      } else if (errorCode === 'auth/configuration-not-found') {
        errorData = {
          title: 'Firebase 設定錯誤',
          message: '請至 Firebase Console > Authentication > Sign-in method 開啟 Google 登入功能。',
          code: errorCode,
          details: '',
        };
      }

      setLoginError(errorData);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setProjects(normalizeProjects(INITIAL_PROJECTS)); // Reset to default on logout
      setActiveProjectId(INITIAL_PROJECTS[0].id);
    } catch (error) {
      console.error('Logout failed', error);
    }
  };

  // --- Project Management ---
  const addProject = () => {
    const newProject: Project = {
      id: `p-${Date.now()}`,
      name: '新專案',
      columns: createInitialColumns(),
      tasks: [],
    };
    const newProjects = [...projects, newProject];
    updateProjects(newProjects);
    setActiveProjectId(newProject.id);
  };

  const deleteProject = (projectId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (projects.length <= 1) {
      alert('至少需要保留一個專案');
      return;
    }
    if (window.confirm('確定要刪除此專案嗎？')) {
      const newProjects = projects.filter((p) => p.id !== projectId);
      updateProjects(newProjects);
      if (activeProjectId === projectId) {
        setActiveProjectId(newProjects[0].id);
      }
    }
  };

  // Use a temporary local update for typing, commit to DB on blur/enter
  const handleProjectNameChange = (projectId: string, newName: string) => {
    setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, name: newName } : p)));
  };

  const commitProjectName = () => {
    // Re-construct projects from current state to ensure we have latest text
    // Actually, 'projects' state already has the text from handleProjectNameChange
    // We just need to trigger the save.
    updateProjects(projects);
    setEditingProjectNameId(null);
  };

  // --- Task Handlers ---
  const handleAddTaskClick = (columnId?: string) => {
    setEditingTask(null);
    setActiveColumnForNewTask(columnId || columns[0]?.id);
    setIsModalOpen(true);
  };

  const handleEditTaskClick = (task: Task) => {
    setEditingTask(task);
    setActiveColumnForNewTask(task.columnId);
    setIsModalOpen(true);
  };

  const saveTask = (taskData: Partial<Task>) => {
    const newProjects = projects.map((project) => {
      if (project.id !== activeProjectId) return project;

      if (editingTask) {
        // Update
        return {
          ...project,
          tasks: project.tasks.map((t) =>
            t.id === editingTask.id ? ({ ...t, ...taskData } as Task) : t,
          ),
        };
      } else {
        // Create
        const targetColumnId = taskData.columnId || activeColumnForNewTask;
        const nextOrder = project.tasks.filter((task) => task.columnId === targetColumnId).length;
        const newTask: Task = {
          id: Date.now().toString(),
          title: taskData.title || 'New Task',
          startDate: taskData.startDate || '',
          endDate: taskData.endDate || '',
          manDays: Number(taskData.manDays) || 0,
          tags: taskData.tags || [],
          assignee: taskData.assignee || '',
          columnId: targetColumnId,
          order: nextOrder,
          icon: taskData.icon || '🐜',
          comments: taskData.comments || [],
        };
        if (taskData.imageUrl) {
          newTask.imageUrl = taskData.imageUrl;
          newTask.imagePath = taskData.imagePath;
        }
        return {
          ...project,
          tasks: [...project.tasks, newTask],
        };
      }
    });
    updateProjects(newProjects);
  };

  const deleteTask = (taskId: string) => {
    const newProjects = projects.map((project) => {
      if (project.id !== activeProjectId) return project;
      return { ...project, tasks: project.tasks.filter((t) => t.id !== taskId) };
    });
    updateProjects(newProjects);
  };

  // --- Column Handlers ---
  const addColumn = () => {
    const newId = `c-${Date.now()}`;
    const newProjects = projects.map((project) => {
      if (project.id !== activeProjectId) return project;
      return {
        ...project,
        columns: [...project.columns, { id: newId, title: '新狀態', color: '#94a3b8' }],
      };
    });
    updateProjects(newProjects);
  };

  const deleteColumn = (columnId: string) => {
    if (window.confirm('確定要刪除此狀態池嗎？其中的任務也將被刪除。')) {
      const newProjects = projects.map((project) => {
        if (project.id !== activeProjectId) return project;
        return {
          ...project,
          columns: project.columns.filter((c) => c.id !== columnId),
          tasks: project.tasks.filter((t) => t.columnId !== columnId),
        };
      });
      updateProjects(newProjects);
    }
  };

  // Local update for typing smoothness
  const handleColumnTitleChange = (id: string, newTitle: string) => {
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== activeProjectId) return project;
        return {
          ...project,
          columns: project.columns.map((c) => (c.id === id ? { ...c, title: newTitle } : c)),
        };
      }),
    );
  };

  // Commit on blur/enter
  const commitColumnTitle = () => {
    updateProjects(projects);
    setEditingColumnId(null);
  };

  const updateColumnColor = (id: string, newColor: string) => {
    const newProjects = projects.map((project) => {
      if (project.id !== activeProjectId) return project;
      return {
        ...project,
        columns: project.columns.map((c) => (c.id === id ? { ...c, color: newColor } : c)),
      };
    });
    updateProjects(newProjects);
  };

  // --- Drag and Drop Logic ---
  const handleDragStart = (event: DragStartEvent) => {
    setActiveDragTaskId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDragTaskId(null);

    if (!over) return;

    const activeTaskId = String(active.id);
    const overId = String(over.id);
    const activeTask = tasks.find((task) => task.id === activeTaskId);
    if (!activeTask) return;

    const targetColumnId = columnIds.has(overId) ? overId : getTaskColumnId(overId, tasks);
    if (!targetColumnId) return;

    const newProjects = projects.map((project) => {
      if (project.id !== activeProjectId) return project;

      const sourceColumnId = activeTask.columnId;
      const sourceTasks = sortTasks(
        project.tasks.filter(
          (task) => task.columnId === sourceColumnId && task.id !== activeTaskId,
        ),
      );
      const targetTasks = sortTasks(
        project.tasks.filter(
          (task) => task.columnId === targetColumnId && task.id !== activeTaskId,
        ),
      );
      const overTaskIndex = targetTasks.findIndex((task) => task.id === overId);
      const insertionIndex =
        columnIds.has(overId) || overTaskIndex === -1 ? targetTasks.length : overTaskIndex;

      const movedTask: Task = { ...activeTask, columnId: targetColumnId };
      const updatedById = new Map<string, Task>();

      if (sourceColumnId === targetColumnId) {
        const reorderedTasks = [...targetTasks];
        reorderedTasks.splice(insertionIndex, 0, movedTask);
        reorderedTasks.forEach((task, index) =>
          updatedById.set(task.id, { ...task, order: index }),
        );
      } else {
        sourceTasks.forEach((task, index) => updatedById.set(task.id, { ...task, order: index }));
        const reorderedTargetTasks = [...targetTasks];
        reorderedTargetTasks.splice(insertionIndex, 0, movedTask);
        reorderedTargetTasks.forEach((task, index) =>
          updatedById.set(task.id, { ...task, order: index }),
        );
      }

      return {
        ...project,
        tasks: project.tasks.map((task) => updatedById.get(task.id) || task),
      };
    });

    updateProjects(newProjects);
  };

  const handleDragCancel = () => {
    setActiveDragTaskId(null);
  };

  // --- Loading Screen ---
  if (authLoading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-gray-50 dark:bg-slate-950">
        <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
      </div>
    );
  }

  // --- Login Screen ---
  if (!user) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center bg-gray-50 dark:bg-slate-950 p-4">
        <div className="bg-white dark:bg-slate-900 p-8 rounded-2xl shadow-xl border border-gray-200 dark:border-slate-800 text-center max-w-md w-full relative">
          <div className="flex justify-center mb-6">
            <span className="text-6xl">🐜</span>
          </div>
          <h1 className="text-2xl font-bold mb-2 text-slate-800 dark:text-slate-100">
            歡迎使用小螞蟻看板
          </h1>
          <p className="text-slate-500 dark:text-slate-400 mb-8">
            登入以進入團隊共用看板，和夥伴即時協作。
          </p>

          {loginError && (
            <div className="mb-6 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-left animate-in fade-in slide-in-from-top-2">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-bold text-red-800 dark:text-red-300 mb-1">
                    {loginError.title}
                  </h3>
                  <p className="text-xs text-red-700 dark:text-red-400 break-words whitespace-pre-wrap mb-2">
                    {loginError.message}
                  </p>

                  {loginError.code === 'auth/unauthorized-domain' && (
                    <div className="space-y-3 bg-white dark:bg-slate-950 p-3 rounded border border-red-100 dark:border-red-900/30">
                      {/* Debug Info */}
                      <div>
                        <p className="text-[10px] uppercase text-slate-400 font-semibold mb-1">
                          系統偵測資訊
                        </p>
                        <code className="block w-full bg-slate-100 dark:bg-slate-900 px-2 py-1.5 rounded border border-slate-200 dark:border-slate-800 text-[10px] font-mono text-slate-600 dark:text-slate-400 break-all">
                          {loginError.details}
                        </code>
                      </div>

                      {/* Manual Instruction */}
                      <div>
                        <p className="text-[10px] uppercase text-slate-400 font-semibold mb-1 flex items-center gap-1">
                          <HelpCircle className="w-3 h-3" /> 如何解決？
                        </p>
                        <p className="text-xs text-slate-600 dark:text-slate-400 mb-2">
                          由於預覽環境的安全限制，系統無法自動抓取正確網域。
                          <br />
                          <br />
                          <span className="font-bold text-slate-800 dark:text-slate-200">
                            請嘗試將以下網域加入 Firebase：
                          </span>
                        </p>
                        <ul className="space-y-1.5">
                          {[
                            'antboard-2025.firebaseapp.com',
                            'antboard-2025.web.app',
                            'localhost',
                          ].map((domain) => (
                            <li key={domain} className="flex gap-2 items-center">
                              <code className="flex-1 bg-slate-50 dark:bg-slate-900 px-2 py-1 rounded border border-slate-200 dark:border-slate-800 text-xs font-mono text-blue-600 dark:text-blue-400">
                                {domain}
                              </code>
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-6 px-2 text-[10px]"
                                onClick={() => {
                                  navigator.clipboard.writeText(domain);
                                  alert(`已複製: ${domain}`);
                                }}
                              >
                                <Copy className="w-3 h-3" />
                              </Button>
                            </li>
                          ))}
                        </ul>
                        <p className="text-[10px] text-slate-500 mt-2">
                          或是請直接複製您目前瀏覽器上方網址列的主網域部分。
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-3">
            <Button onClick={handleLogin} className="w-full h-12 text-base gap-2">
              <LogIn className="w-5 h-5" />
              使用 Google 帳號登入
            </Button>
          </div>

          <div className="mt-6 flex justify-center">
            <Button variant="ghost" onClick={() => setIsDarkMode(!isDarkMode)} size="sm">
              {isDarkMode ? <Sun className="w-4 h-4 mr-2" /> : <Moon className="w-4 h-4 mr-2" />}
              {isDarkMode ? '切換至亮色模式' : '切換至暗色模式'}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gray-50 dark:bg-slate-950 transition-colors duration-200 flex font-sans overflow-hidden">
      {/* Sidebar - Project List */}
      <aside className="w-64 bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-800 flex flex-col flex-shrink-0 z-20 shadow-md">
        <div className="h-16 flex items-center px-5 border-b border-gray-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <span className="text-3xl leading-none select-none">🐜</span>
            <h1 className="font-bold text-gray-800 dark:text-gray-100 tracking-tight text-lg">
              小螞蟻看板
            </h1>
          </div>
        </div>

        <div className="p-4 flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between mb-2 px-1">
            <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">
              團隊專案
            </h2>
            <button
              onClick={addProject}
              className="text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 p-1"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {dataLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
            </div>
          ) : (
            <div className="space-y-1 overflow-y-auto pr-1 custom-scrollbar flex-1">
              {projects.map((project) => (
                <div
                  key={project.id}
                  onClick={() => setActiveProjectId(project.id)}
                  className={`group flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
                    activeProjectId === project.id
                      ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 font-medium'
                      : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                  }`}
                >
                  <div className="flex items-center gap-2.5 truncate flex-1">
                    <FolderOpen
                      className={`w-4 h-4 flex-shrink-0 ${activeProjectId === project.id ? 'fill-blue-200 dark:fill-blue-900' : ''}`}
                    />

                    {editingProjectNameId === project.id ? (
                      <input
                        autoFocus
                        value={project.name}
                        onChange={(e) => handleProjectNameChange(project.id, e.target.value)}
                        onBlur={commitProjectName}
                        onKeyDown={(e) => e.key === 'Enter' && commitProjectName()}
                        onClick={(e) => e.stopPropagation()}
                        className="bg-transparent border-b border-blue-500 focus:outline-none w-full text-sm"
                      />
                    ) : (
                      <span className="truncate text-sm">{project.name}</span>
                    )}
                  </div>

                  <div
                    className={`flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${activeProjectId === project.id ? 'opacity-100' : ''}`}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingProjectNameId(project.id);
                      }}
                      className="p-1 hover:bg-black/5 dark:hover:bg-white/10 rounded"
                    >
                      <PenLine className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => deleteProject(project.id, e)}
                      className="p-1 hover:bg-red-100 dark:hover:bg-red-900/40 hover:text-red-600 rounded"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* User Profile & Dark Mode */}
        <div className="p-4 border-t border-gray-100 dark:border-slate-800 space-y-2">
          <div className="flex items-center gap-3 px-2 py-2 mb-2">
            <img
              src={
                user.photoURL || `https://ui-avatars.com/api/?name=${user.displayName || 'User'}`
              }
              alt="User"
              className="w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700"
            />

            <div className="flex-1 truncate">
              <p className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                {user.displayName || 'Google 使用者'}
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{user.email}</p>
            </div>
          </div>

          <Button
            onClick={() => setIsDarkMode(!isDarkMode)}
            variant="ghost"
            className="w-full justify-start gap-3 h-9"
            size="sm"
          >
            {isDarkMode ? (
              <Sun className="w-4 h-4 text-yellow-500" />
            ) : (
              <Moon className="w-4 h-4 text-slate-600" />
            )}
            <span className="text-sm">{isDarkMode ? '亮色模式' : '暗色模式'}</span>
          </Button>

          <Button
            onClick={handleLogout}
            variant="ghost"
            className="w-full justify-start gap-3 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 h-9"
            size="sm"
          >
            <LogOut className="w-4 h-4" />
            <span className="text-sm">登出</span>
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full overflow-hidden">
        {/* Header */}
        <header className="h-16 flex-shrink-0 border-b border-gray-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/80 backdrop-blur-sm px-6 flex items-center justify-between z-10">
          <div className="flex items-center gap-3">
            <Layout className="w-5 h-5 text-slate-400" />
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">
              {activeProject?.name}
            </h2>
            {dataLoading && (
              <span className="text-xs text-slate-400 ml-2 animate-pulse">同步中...</span>
            )}
          </div>
          <Button onClick={addColumn} variant="secondary" size="sm">
            <Plus className="w-4 h-4 mr-2" />
            新增狀態池
          </Button>
        </header>

        {/* Board Area */}
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className="h-full p-6 flex items-start gap-6 min-w-max">
              {columns.map((column) => {
                const columnTasks = sortedTasks.filter((task) => task.columnId === column.id);

                return (
                  <KanbanColumn
                    key={column.id}
                    column={column}
                    tasks={columnTasks}
                    isActiveDrag={Boolean(activeDragTaskId)}
                    isEditing={editingColumnId === column.id}
                    onEditTask={handleEditTaskClick}
                    onAddTask={handleAddTaskClick}
                    onDeleteColumn={deleteColumn}
                    onColorChange={updateColumnColor}
                    onTitleChange={handleColumnTitleChange}
                    onTitleCommit={commitColumnTitle}
                    onStartTitleEdit={setEditingColumnId}
                  />
                );
              })}

              {/* Add Column Button (End of list) */}
              <button
                onClick={addColumn}
                className="w-80 h-12 flex-shrink-0 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 dark:border-slate-800 text-gray-500 dark:text-slate-500 hover:border-blue-500 hover:text-blue-500 hover:bg-blue-50/50 dark:hover:bg-blue-900/20 transition-all group"
                type="button"
              >
                <Plus className="w-5 h-5 group-hover:scale-110 transition-transform" />
                <span>新增列表</span>
              </button>
            </div>

            <DragOverlay
              dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}
            >
              {activeDragTask ? (
                <TaskCard task={activeDragTask} onEdit={handleEditTaskClick} isDragging={false} />
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </main>

      <TaskModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={saveTask}
        onDelete={deleteTask}
        initialData={editingTask}
        columns={columns}
        activeColumnId={activeColumnForNewTask}
        currentUser={
          user
            ? {
                uid: user.uid,
                displayName: user.displayName,
                email: user.email,
              }
            : null
        }
      />
    </div>
  );
};

export default App;

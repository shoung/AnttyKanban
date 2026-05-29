import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { Plus, Trash2 } from 'lucide-react';
import { Column, Task } from '../types';
import { SortableTaskCard } from './SortableTaskCard';

interface KanbanColumnProps {
  column: Column;
  tasks: Task[];
  isActiveDrag: boolean;
  isEditing: boolean;
  onEditTask: (task: Task) => void;
  onAddTask: (columnId: string) => void;
  onDeleteColumn: (columnId: string) => void;
  onColorChange: (columnId: string, color: string) => void;
  onTitleChange: (columnId: string, title: string) => void;
  onTitleCommit: () => void;
  onStartTitleEdit: (columnId: string) => void;
}

export const KanbanColumn: React.FC<KanbanColumnProps> = ({
  column,
  tasks,
  isActiveDrag,
  isEditing,
  onEditTask,
  onAddTask,
  onDeleteColumn,
  onColorChange,
  onTitleChange,
  onTitleCommit,
  onStartTitleEdit,
}) => {
  const { isOver, setNodeRef } = useDroppable({
    id: column.id,
    data: {
      type: 'column',
      columnId: column.id,
    },
  });

  return (
    <div
      ref={setNodeRef}
      className={`w-[42rem] flex-shrink-0 flex flex-col max-h-[calc(100vh-8rem)] rounded-xl bg-gray-100/80 dark:bg-slate-900/50 border backdrop-blur-sm transition-all ${
        isOver
          ? 'border-blue-400 ring-2 ring-blue-300/60 bg-blue-50/80 dark:bg-blue-950/20'
          : 'border-gray-200 dark:border-slate-800'
      }`}
    >
      <div className="p-4 flex items-center justify-between group relative">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="relative w-4 h-4 flex-shrink-0 cursor-pointer overflow-hidden rounded-full shadow-sm ring-2 ring-white dark:ring-slate-800 hover:scale-110 transition-transform">
            <input
              type="color"
              value={column.color}
              onChange={(event) => onColorChange(column.id, event.target.value)}
              className="absolute -top-1/2 -left-1/2 w-[200%] h-[200%] p-0 m-0 cursor-pointer border-none opacity-100"
              title="點擊修改顏色"
            />
          </div>

          {isEditing ? (
            <input
              autoFocus
              value={column.title}
              onChange={(event) => onTitleChange(column.id, event.target.value)}
              onBlur={onTitleCommit}
              onKeyDown={(event) => event.key === 'Enter' && onTitleCommit()}
              className="bg-transparent border-b-2 border-blue-500 focus:outline-none text-lg font-bold text-gray-800 dark:text-gray-100 w-full py-0.5"
            />
          ) : (
            <h2
              onClick={() => onStartTitleEdit(column.id)}
              className="text-lg font-bold text-gray-800 dark:text-gray-100 cursor-text hover:text-blue-600 dark:hover:text-blue-400 transition-colors py-0.5 truncate"
            >
              {column.title}
            </h2>
          )}
          <span className="text-xs text-gray-400 font-medium bg-gray-200 dark:bg-slate-800 px-2 py-0.5 rounded-full">
            {tasks.length}
          </span>
        </div>

        <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity gap-1">
          <button
            onClick={() => onAddTask(column.id)}
            className="p-1.5 hover:bg-gray-200 dark:hover:bg-slate-800 rounded text-gray-500 dark:text-gray-400"
            title="新增任務"
            type="button"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDeleteColumn(column.id)}
            className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/30 rounded text-gray-400 hover:text-red-500 transition-colors"
            title="刪除此狀態池"
            type="button"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      <SortableContext items={tasks.map((task) => task.id)} strategy={rectSortingStrategy}>
        <div className="flex-1 overflow-y-auto px-3 pb-3 grid grid-cols-2 gap-3 content-start scrollbar-hide min-h-32">
          {tasks.map((task) => (
            <SortableTaskCard key={task.id} task={task} onEdit={onEditTask} />
          ))}

          {tasks.length === 0 && (
            <div
              className={`col-span-2 h-24 border-2 border-dashed rounded-lg flex items-center justify-center text-sm transition-colors ${
                isActiveDrag || isOver
                  ? 'border-blue-300 text-blue-500 bg-blue-50/80 dark:border-blue-700 dark:text-blue-300 dark:bg-blue-950/20'
                  : 'border-gray-200 dark:border-slate-800 text-gray-400 bg-white/50 dark:bg-slate-800/20'
              }`}
            >
              {isActiveDrag ? '放開即可移至此欄' : '無任務'}
            </div>
          )}

          {isActiveDrag && tasks.length > 0 && isOver && (
            <div className="col-span-2 h-12 border-2 border-dashed border-blue-300 dark:border-blue-700 rounded-lg bg-blue-50/80 dark:bg-blue-950/20 flex items-center justify-center text-xs text-blue-500 dark:text-blue-300">
              放開以排序或移動到此欄
            </div>
          )}

          <button
            onClick={() => onAddTask(column.id)}
            className="col-span-2 w-full py-2 flex items-center justify-center gap-2 text-gray-500 hover:text-gray-700 dark:text-slate-500 dark:hover:text-slate-300 hover:bg-gray-200/50 dark:hover:bg-slate-800/50 rounded-md transition-colors text-sm border border-transparent hover:border-dashed hover:border-gray-300 dark:hover:border-slate-700"
            type="button"
          >
            <Plus className="w-4 h-4" />
            新建卡片
          </button>
        </div>
      </SortableContext>
    </div>
  );
};

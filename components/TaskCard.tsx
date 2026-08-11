import React from 'react';
import { GripVertical, Hash, MessageCircle, User } from 'lucide-react';
import { Task } from '../types';
import { getTaskCardColorOption } from './taskCardColors';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  dragAttributes?: React.HTMLAttributes<HTMLDivElement>;
  dragListeners?: React.HTMLAttributes<HTMLDivElement>;
  setDragHandleRef?: (element: HTMLDivElement | null) => void;
  isDragging?: boolean;
  style?: React.CSSProperties;
}

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  onEdit,
  dragAttributes,
  dragListeners,
  setDragHandleRef,
  isDragging = false,
  style,
}) => {
  const colorOption = getTaskCardColorOption(task.color);
  const commentCount = task.comments?.length || 0;
  const imageAlt = task.title ? `${task.title} 附圖` : '任務附圖';

  return (
    <div
      ref={setDragHandleRef}
      style={style}
      onClick={() => onEdit(task)}
      className={`group p-3 rounded-lg border shadow-sm hover:shadow-md transition-all cursor-pointer active:cursor-grabbing touch-none relative ${colorOption.className} ${
        isDragging ? 'opacity-40 ring-2 ring-blue-400 shadow-lg scale-[0.98]' : ''
      }`}
      {...dragAttributes}
      {...dragListeners}
    >
      <div className="flex justify-between items-start mb-2 gap-2">
        <div className="flex items-start gap-2 overflow-hidden w-full">
          <div
            aria-hidden="true"
            className="-ml-1 mt-0.5 p-1 rounded text-slate-400 group-hover:text-blue-600 dark:group-hover:text-blue-300 cursor-grab active:cursor-grabbing"
          >
            <GripVertical className="w-4 h-4" />
          </div>
          <div className="min-w-0 w-full">
            <h3 className="font-bold text-slate-800 dark:text-slate-100 text-base leading-tight break-words pt-0.5">
              {task.title}
            </h3>
            {task.description && (
              <p className="mt-1 max-h-10 overflow-hidden whitespace-pre-wrap break-words text-xs leading-5 text-slate-600 dark:text-slate-300">
                {task.description}
              </p>
            )}
          </div>
        </div>
      </div>

      {task.imageUrl && (
        <img
          src={task.imageUrl}
          alt={imageAlt}
          className="w-full h-32 object-cover rounded-md border border-slate-200/70 dark:border-slate-700/70 bg-slate-100 dark:bg-slate-900 mb-3"
          loading="lazy"
        />
      )}

      <div className="space-y-2">
        {task.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {task.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
              >
                <Hash className="w-2 h-2 mr-0.5" />
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center text-xs text-slate-500 dark:text-slate-400 gap-2">
          <User className="w-3 h-3" />
          <span className="truncate max-w-[100px]">{task.assignee || '未指派'}</span>
        </div>

        {commentCount > 0 && (
          <div className="inline-flex items-center gap-1.5 mt-2 px-2 py-1 rounded-full bg-slate-100 text-slate-600 dark:bg-slate-700/70 dark:text-slate-300 text-[11px] font-medium">
            <MessageCircle className="w-3 h-3" />
            <span>{commentCount} 則留言</span>
          </div>
        )}
      </div>
    </div>
  );
};

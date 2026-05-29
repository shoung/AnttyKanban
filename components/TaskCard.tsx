import React, { useState } from 'react';
import { Calendar, Clock, GripVertical, Hash, MessageCircle, User } from 'lucide-react';
import { Task } from '../types';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  dragAttributes?: React.HTMLAttributes<HTMLButtonElement>;
  dragListeners?: React.HTMLAttributes<HTMLButtonElement>;
  setDragHandleRef?: (element: HTMLButtonElement | null) => void;
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
  const getUrgencyStyles = (endDateStr: string) => {
    if (!endDateStr) return 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700';

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const end = new Date(endDateStr);
    end.setHours(0, 0, 0, 0);

    const diffTime = end.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return 'bg-pink-50 dark:bg-pink-900/20 border-pink-200 dark:border-pink-800/50 shadow-sm';
    }

    if (diffDays === 1) {
      return 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50 shadow-sm';
    }

    return 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 shadow-sm';
  };

  const cardStyle = getUrgencyStyles(task.endDate);
  const commentCount = task.comments?.length || 0;
  const [isImagePreviewOpen, setIsImagePreviewOpen] = useState(false);
  const imageAlt = task.title ? `${task.title} 附圖` : '任務附圖';

  return (
    <div
      style={style}
      onClick={() => onEdit(task)}
      className={`group p-3 rounded-lg border hover:shadow-md transition-all cursor-pointer relative ${cardStyle} ${
        isDragging ? 'opacity-40 ring-2 ring-blue-400 shadow-lg scale-[0.98]' : ''
      }`}
    >
      <div className="flex justify-between items-start mb-2 gap-2">
        <div className="flex items-start gap-2 overflow-hidden w-full">
          <button
            ref={setDragHandleRef}
            type="button"
            aria-label={`拖曳任務「${task.title}」`}
            onClick={(event) => event.stopPropagation()}
            className="-ml-1 mt-0.5 p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-slate-700 dark:hover:text-blue-300 cursor-grab active:cursor-grabbing touch-none focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            {...dragAttributes}
            {...dragListeners}
          >
            <GripVertical className="w-4 h-4" />
          </button>
          <span className="text-xl flex-shrink-0 leading-tight mt-0.5">{task.icon || '📝'}</span>
          <h3 className="font-bold text-slate-800 dark:text-slate-100 text-base leading-tight break-words pt-0.5 w-full">
            {task.title}
          </h3>
        </div>
      </div>

      {task.imageUrl && (
        <>
          <button
            type="button"
            aria-label={`放大檢視${imageAlt}`}
            onClick={(event) => {
              event.stopPropagation();
              setIsImagePreviewOpen(true);
            }}
            className="block w-full mb-3 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-800"
          >
            <img
              src={task.imageUrl}
              alt={imageAlt}
              className="w-full h-32 object-cover rounded-md border border-slate-200/70 dark:border-slate-700/70 bg-slate-100 dark:bg-slate-900"
              loading="lazy"
            />
          </button>

          {isImagePreviewOpen && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 cursor-zoom-out"
              onClick={(event) => {
                event.stopPropagation();
                setIsImagePreviewOpen(false);
              }}
              role="presentation"
            >
              <img
                src={task.imageUrl}
                alt={imageAlt}
                className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg shadow-2xl cursor-default"
                onClick={(event) => event.stopPropagation()}
              />
            </div>
          )}
        </>
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

        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-2 border-t border-slate-200/50 dark:border-slate-700/50">
          <div className="flex items-center gap-1.5" title="Start - End Date">
            <Calendar className="w-3 h-3" />
            <span
              className={
                task.endDate === new Date().toISOString().split('T')[0]
                  ? 'text-pink-600 dark:text-pink-400 font-medium'
                  : ''
              }
            >
              {task.endDate.slice(5) || '--/--'}
            </span>
          </div>
          <div className="flex items-center gap-1.5" title="Man Days">
            <Clock className="w-3 h-3" />
            <span>{task.manDays}d</span>
          </div>
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

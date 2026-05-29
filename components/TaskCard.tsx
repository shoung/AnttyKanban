import React from 'react';
import { Calendar, User, Clock, Hash } from 'lucide-react';
import { Task } from '../types';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (taskId: string) => void;
  onDragStart: (e: React.DragEvent, taskId: string) => void;
}

export const TaskCard: React.FC<TaskCardProps> = ({ task, onEdit, onDelete, onDragStart }) => {
  
  // Date calculation helper
  const getUrgencyStyles = (endDateStr: string) => {
    if (!endDateStr) return "bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700";
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const end = new Date(endDateStr);
    end.setHours(0, 0, 0, 0);
    
    const diffTime = end.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    // Today (Pink)
    if (diffDays === 0) {
      return "bg-pink-50 dark:bg-pink-900/20 border-pink-200 dark:border-pink-800/50 shadow-sm";
    }
    
    // Tomorrow (Light Yellow)
    if (diffDays === 1) {
      return "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50 shadow-sm";
    }

    // Default
    return "bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 shadow-sm";
  };

  const cardStyle = getUrgencyStyles(task.endDate);

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, task.id)}
      onClick={() => onEdit(task)}
      className={`group p-3 rounded-lg border hover:shadow-md transition-all cursor-pointer relative ${cardStyle}`}
    >
      <div className="flex justify-between items-start mb-2 gap-2">
        <div className="flex items-start gap-2 overflow-hidden w-full">
          <span className="text-xl flex-shrink-0 leading-tight mt-0.5">{task.icon || '📝'}</span>
          <h3 className="font-bold text-slate-800 dark:text-slate-100 text-base leading-tight break-words pt-0.5 w-full">
            {task.title}
          </h3>
        </div>
      </div>

      {task.imageUrl && (
        <img
          src={task.imageUrl}
          alt={task.title ? `${task.title} 附圖` : '任務附圖'}
          className="w-full h-32 object-cover rounded-md mb-3 border border-slate-200/70 dark:border-slate-700/70 bg-slate-100 dark:bg-slate-900"
          loading="lazy"
        />
      )}

      <div className="space-y-2">
        {/* Tags */}
        {task.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {task.tags.map((tag, idx) => (
              <span key={idx} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
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
            <span className={task.endDate === new Date().toISOString().split('T')[0] ? "text-pink-600 dark:text-pink-400 font-medium" : ""}>
              {task.endDate.slice(5) || '--/--'}
            </span>
          </div>
          <div className="flex items-center gap-1.5" title="Man Days">
            <Clock className="w-3 h-3" />
            <span>{task.manDays}d</span>
          </div>
        </div>
      </div>
    </div>
  );
};
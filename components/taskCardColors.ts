import { TaskCardColor } from '../types';

export interface TaskCardColorOption {
  id: TaskCardColor;
  label: string;
  className: string;
  swatchClassName: string;
}

export const TASK_CARD_COLOR_OPTIONS: TaskCardColorOption[] = [
  { id: 'white', label: '白色', className: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700', swatchClassName: 'bg-white border-slate-300' },
  { id: 'gray', label: '灰色', className: 'bg-slate-100 dark:bg-slate-700 border-slate-200 dark:border-slate-600', swatchClassName: 'bg-slate-100 border-slate-300' },
  { id: 'red', label: '紅色', className: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900', swatchClassName: 'bg-red-50 border-red-200' },
  { id: 'orange', label: '橙色', className: 'bg-orange-50 dark:bg-orange-950/40 border-orange-200 dark:border-orange-900', swatchClassName: 'bg-orange-50 border-orange-200' },
  { id: 'yellow', label: '黃色', className: 'bg-yellow-50 dark:bg-yellow-950/40 border-yellow-200 dark:border-yellow-900', swatchClassName: 'bg-yellow-50 border-yellow-200' },
  { id: 'green', label: '綠色', className: 'bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-900', swatchClassName: 'bg-green-50 border-green-200' },
  { id: 'blue', label: '藍色', className: 'bg-blue-50 dark:bg-blue-950/40 border-blue-200 dark:border-blue-900', swatchClassName: 'bg-blue-50 border-blue-200' },
  { id: 'indigo', label: '靛色', className: 'bg-indigo-50 dark:bg-indigo-950/40 border-indigo-200 dark:border-indigo-900', swatchClassName: 'bg-indigo-50 border-indigo-200' },
  { id: 'purple', label: '紫色', className: 'bg-purple-50 dark:bg-purple-950/40 border-purple-200 dark:border-purple-900', swatchClassName: 'bg-purple-50 border-purple-200' },
  { id: 'pink', label: '粉紅色', className: 'bg-pink-50 dark:bg-pink-950/40 border-pink-200 dark:border-pink-900', swatchClassName: 'bg-pink-50 border-pink-200' },
];

export const getTaskCardColorOption = (color?: string) =>
  TASK_CARD_COLOR_OPTIONS.find((option) => option.id === color) ?? TASK_CARD_COLOR_OPTIONS[0];

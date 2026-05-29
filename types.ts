export interface Task {
  id: string;
  title: string;
  description?: string;
  startDate: string;
  endDate: string;
  manDays: number;
  tags: string[];
  assignee: string;
  columnId: string;
  order: number;
  icon: string;
  imageUrl?: string;
  imagePath?: string;
}

export interface Column {
  id: string;
  title: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  columns: Column[];
  tasks: Task[];
}

export type Theme = 'light' | 'dark';

export interface DragItem {
  type: 'TASK';
  id: string;
  columnId: string;
}

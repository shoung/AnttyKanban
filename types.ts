export interface TaskComment {
  id: string;
  text: string;
  authorName: string;
  authorId: string;
  createdAt: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  tags: string[];
  assignee: string;
  columnId: string;
  order: number;
  color?: TaskCardColor;
  imageUrl?: string;
  imagePath?: string;
  comments: TaskComment[];
}

export type TaskCardColor =
  | 'white'
  | 'gray'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink';

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

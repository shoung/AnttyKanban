import React, { useState, useEffect } from 'react';
import {
  X,
  Plus,
  Trash2,
  Calendar as CalendarIcon,
  Upload,
  Loader2,
  MessageCircle,
  Send,
} from 'lucide-react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { Task, Column, TaskComment } from '../types';
import { Button } from './Button';
import { storage } from '../firebase';

interface CurrentUserInfo {
  uid: string;
  displayName?: string | null;
  email?: string | null;
}

interface TaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (task: Partial<Task>) => void;
  onDelete?: (taskId: string) => void;
  initialData?: Task | null;
  columns: Column[];
  activeColumnId?: string;
  currentUser?: CurrentUserInfo | null;
}

const EMOJI_OPTIONS = ['🐜', '📝', '🐛', '✨', '🚀', '🎨', '🔥', '📅', '💻', '📢', '🔒', '📈'];

export const TaskModal: React.FC<TaskModalProps> = ({
  isOpen,
  onClose,
  onSave,
  onDelete,
  initialData,
  columns,
  activeColumnId,
  currentUser,
}) => {
  const [formData, setFormData] = useState<Partial<Task>>({
    title: '',
    startDate: '',
    endDate: '',
    manDays: 0,
    assignee: '',
    tags: [],
    columnId: '',
    icon: '🐜',
    comments: [],
  });

  const [tagInput, setTagInput] = useState('');
  const [commentInput, setCommentInput] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const [isUploadingImage, setIsUploadingImage] = useState(false);

  useEffect(() => {
    if (isOpen) {
      if (initialData) {
        setFormData({ ...initialData, comments: initialData.comments || [] });
      } else {
        setFormData({
          title: '',
          startDate: new Date().toISOString().split('T')[0],
          endDate: '',
          manDays: 1,
          assignee: '',
          tags: [],
          columnId: activeColumnId || columns[0]?.id || '',
          icon: '🐜',
          comments: [],
        });
      }
      setTagInput('');
      setCommentInput('');
      setEditingCommentId(null);
      setEditingCommentText('');
    }
  }, [isOpen, initialData, activeColumnId, columns]);

  if (!isOpen) return null;

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleAddTag = (e: React.KeyboardEvent | React.MouseEvent) => {
    if ((e.type === 'keydown' && (e as React.KeyboardEvent).key !== 'Enter') || !tagInput.trim())
      return;
    e.preventDefault();
    if (formData.tags && !formData.tags.includes(tagInput.trim())) {
      setFormData((prev) => ({ ...prev, tags: [...(prev.tags || []), tagInput.trim()] }));
    }
    setTagInput('');
  };

  const removeTag = (tagToRemove: string) => {
    setFormData((prev) => ({ ...prev, tags: prev.tags?.filter((t) => t !== tagToRemove) }));
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('請選擇圖片檔案');
      return;
    }

    setIsUploadingImage(true);
    try {
      const safeFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');
      const imagePath = `task-images/${Date.now()}-${safeFileName}`;
      const imageRef = ref(storage, imagePath);
      await uploadBytes(imageRef, file, { contentType: file.type });
      const imageUrl = await getDownloadURL(imageRef);
      setFormData((prev) => ({ ...prev, imageUrl, imagePath }));
    } catch (error) {
      console.error('Image upload failed:', error);
      alert('圖片上傳失敗，請確認 Firebase Storage Rules 是否允許登入者上傳。');
    } finally {
      setIsUploadingImage(false);
    }
  };

  const removeImage = () => {
    setFormData((prev) => ({ ...prev, imageUrl: '', imagePath: '' }));
  };

  const formatCommentTime = (createdAt: string) =>
    new Date(createdAt).toLocaleString('zh-TW', { hour12: false });

  const sortedComments = [...(formData.comments || [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );

  const persistComments = (comments: TaskComment[]) => {
    const nextFormData: Partial<Task> = {
      ...formData,
      comments,
    };

    setFormData(nextFormData);

    if (initialData) {
      onSave(nextFormData);
    }
  };

  const handleAddComment = () => {
    const text = commentInput.trim();
    if (!text || !currentUser) return;

    const nextFormData: Partial<Task> = {
      ...formData,
      comments: [
        ...(formData.comments || []),
        {
          id: `comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text,
          authorId: currentUser.uid,
          authorName: currentUser.displayName || currentUser.email || '未知使用者',
          createdAt: new Date().toISOString(),
        },
      ],
    };

    setFormData(nextFormData);
    setCommentInput('');

    if (initialData) {
      onSave(nextFormData);
    }
  };

  const handleStartEditComment = (comment: TaskComment) => {
    if (currentUser?.uid !== comment.authorId) return;
    setEditingCommentId(comment.id);
    setEditingCommentText(comment.text);
  };

  const handleCancelEditComment = () => {
    setEditingCommentId(null);
    setEditingCommentText('');
  };

  const handleSaveEditedComment = (commentId: string) => {
    const text = editingCommentText.trim();
    if (!text || !currentUser) return;

    const comments = (formData.comments || []).map((comment) =>
      comment.id === commentId && comment.authorId === currentUser.uid
        ? { ...comment, text }
        : comment,
    );

    persistComments(comments);
    handleCancelEditComment();
  };

  const handleDeleteComment = (commentId: string) => {
    if (!currentUser) return;

    const comment = (formData.comments || []).find((item) => item.id === commentId);
    if (!comment || comment.authorId !== currentUser.uid) return;

    const comments = (formData.comments || []).filter((item) => item.id !== commentId);
    persistComments(comments);

    if (editingCommentId === commentId) {
      handleCancelEditComment();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isUploadingImage) return;
    onSave(formData);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto border border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between p-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 sticky top-0">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            {initialData ? '編輯任務' : '新建任務'}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-5">
          {/* Icon Selection */}
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              選擇圖示
            </label>
            <div className="flex flex-wrap gap-2 bg-slate-50 dark:bg-slate-800/50 p-2 rounded-lg border border-slate-100 dark:border-slate-800">
              {EMOJI_OPTIONS.map((emoji) => (
                <button
                  type="button"
                  key={emoji}
                  onClick={() => setFormData((prev) => ({ ...prev, icon: emoji }))}
                  className={`w-9 h-9 flex items-center justify-center rounded-md text-xl transition-all ${
                    formData.icon === emoji
                      ? 'bg-blue-100 dark:bg-blue-900/50 ring-2 ring-blue-500 scale-110'
                      : 'hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              任務名稱
            </label>
            <input
              required
              name="title"
              value={formData.title}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-md bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
              placeholder="輸入任務名稱..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
              任務圖片
            </label>

            {formData.imageUrl && (
              <div className="relative mb-3 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
                <img
                  src={formData.imageUrl}
                  alt="任務圖片預覽"
                  className="w-full max-h-56 object-cover bg-slate-100 dark:bg-slate-800"
                />
                <button
                  type="button"
                  onClick={removeImage}
                  disabled={isUploadingImage}
                  className="absolute top-2 right-2 p-1.5 rounded-full bg-black/60 text-white hover:bg-red-600 disabled:opacity-60 transition-colors"
                  title="移除圖片"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            <label
              className={`flex items-center justify-center gap-2 w-full px-3 py-3 border border-dashed border-slate-300 dark:border-slate-700 rounded-md text-sm text-slate-600 dark:text-slate-300 transition-colors ${
                isUploadingImage
                  ? 'cursor-not-allowed opacity-70'
                  : 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50'
              }`}
            >
              {isUploadingImage ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {isUploadingImage ? '圖片上傳中...' : formData.imageUrl ? '更換圖片' : '選擇圖片上傳'}
              <input
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                disabled={isUploadingImage}
                className="hidden"
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                起始日
              </label>
              <div className="relative">
                <input
                  type="date"
                  name="startDate"
                  value={formData.startDate}
                  onChange={handleInputChange}
                  className="w-full pl-3 pr-2 py-2 border border-slate-300 dark:border-slate-700 rounded-md bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                />
                <CalendarIcon className="w-4 h-4 absolute right-3 top-2.5 text-slate-400 pointer-events-none" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                截止日
              </label>
              <div className="relative">
                <input
                  type="date"
                  name="endDate"
                  value={formData.endDate}
                  onChange={handleInputChange}
                  className="w-full pl-3 pr-2 py-2 border border-slate-300 dark:border-slate-700 rounded-md bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                />
                <CalendarIcon className="w-4 h-4 absolute right-3 top-2.5 text-slate-400 pointer-events-none" />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                人天 (Man-days)
              </label>
              <input
                type="number"
                min="0"
                step="0.5"
                name="manDays"
                value={formData.manDays}
                onChange={handleInputChange}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-md bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                執行者
              </label>
              <input
                type="text"
                name="assignee"
                value={formData.assignee}
                onChange={handleInputChange}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-md bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="誰負責?"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              狀態
            </label>
            <select
              name="columnId"
              value={formData.columnId}
              onChange={handleInputChange}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-md bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {columns.map((col) => (
                <option key={col.id} value={col.id} className="dark:bg-slate-900">
                  {col.title}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
              標籤 (Hashtags)
            </label>
            <div className="flex gap-2 mb-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleAddTag}
                className="flex-1 px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-md bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="輸入後按 Enter..."
              />
              <Button type="button" variant="secondary" onClick={handleAddTag} size="sm">
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 min-h-[2rem]">
              {formData.tags?.map((tag, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center px-2 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border border-slate-200 dark:border-slate-700"
                >
                  #{tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="ml-1.5 text-slate-400 hover:text-red-500"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between mb-3">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-300">
                <MessageCircle className="w-4 h-4" />
                留言 ({sortedComments.length})
              </label>
              <span className="text-[11px] text-slate-400">由舊到新排序</span>
            </div>

            <div className="space-y-3 max-h-60 overflow-y-auto pr-1 mb-3">
              {sortedComments.length > 0 ? (
                sortedComments.map((comment) => {
                  const isOwnComment = currentUser?.uid === comment.authorId;
                  const isEditingComment = editingCommentId === comment.id;

                  return (
                    <div
                      key={comment.id}
                      className="rounded-lg bg-slate-50 dark:bg-slate-800/70 border border-slate-100 dark:border-slate-700 p-3"
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="min-w-0">
                          <span className="block text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                            {comment.authorName || '未知使用者'}
                          </span>
                          <time className="text-[11px] text-slate-400">
                            {formatCommentTime(comment.createdAt)}
                          </time>
                        </div>

                        {isOwnComment && !isEditingComment && (
                          <div className="flex flex-shrink-0 items-center gap-2 text-xs">
                            <button
                              type="button"
                              onClick={() => handleStartEditComment(comment)}
                              className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
                            >
                              編輯
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteComment(comment.id)}
                              className="text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                            >
                              刪除
                            </button>
                          </div>
                        )}
                      </div>

                      {isEditingComment ? (
                        <div className="space-y-2">
                          <textarea
                            value={editingCommentText}
                            onChange={(e) => setEditingCommentText(e.target.value)}
                            className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-20 resize-y"
                            autoFocus
                          />
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={handleCancelEditComment}
                              className="text-xs px-2 py-1 rounded-md text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                            >
                              取消
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSaveEditedComment(comment.id)}
                              disabled={!editingCommentText.trim()}
                              className="text-xs px-2 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              儲存
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words">
                          {comment.text}
                        </p>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="text-sm text-slate-400 text-center py-4 border border-dashed border-slate-200 dark:border-slate-700 rounded-lg">
                  尚無留言，成為第一個留言的人吧。
                </div>
              )}
            </div>

            <div className="space-y-2">
              <textarea
                value={commentInput}
                onChange={(e) => setCommentInput(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded-md bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 min-h-20 resize-y"
                placeholder={currentUser ? '輸入留言...' : '請先登入後再留言'}
                disabled={!currentUser}
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  onClick={handleAddComment}
                  disabled={!commentInput.trim() || !currentUser}
                >
                  <Send className="w-4 h-4 mr-2" />
                  送出留言
                </Button>
              </div>
              {!initialData && sortedComments.length > 0 && (
                <p className="text-[11px] text-slate-400 text-right">
                  新任務的留言會在儲存任務後一併同步。
                </p>
              )}
            </div>
          </div>

          <div className="flex justify-between pt-4 border-t border-slate-200 dark:border-slate-800 mt-6">
            {initialData && onDelete ? (
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  onDelete(initialData.id);
                  onClose();
                }}
              >
                <Trash2 className="w-4 h-4 mr-2" />
                刪除
              </Button>
            ) : (
              <div></div>
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={isUploadingImage}>
                取消
              </Button>
              <Button type="submit" disabled={isUploadingImage}>
                {isUploadingImage ? '上傳中...' : '儲存'}
              </Button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

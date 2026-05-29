# AnttyKanban QA 驗證報告

## 本次 QA：卡片留言與時間戳功能

### 結論

**整體結果：PASS**

本次針對「每張卡片內，使用者可以相互留言，留言時要紀錄下時間戳」進行程式碼審查、diff 驗證與實際建置檢查。已確認留言資料模型、舊資料 normalize、新增/編輯任務預設值、Modal 新增留言流程、作者與本地化時間顯示、ISO timestamp 寫入、既有任務即時 onSave/Firestore 寫回、TaskCard 留言數量顯示，以及圖片、tags、assignee、日期、人天與 DnD 相關既有功能未被破壞。

未發現阻斷性問題；`npm run build` 僅有既有 Vite chunk size warning，屬非阻斷。

### 驗證範圍

檢查檔案：

- `types.ts`
- `App.tsx`
- `components/TaskModal.tsx`
- `components/TaskCard.tsx`
- `components/KanbanColumn.tsx`
- `components/SortableTaskCard.tsx`

執行指令：

```bash
npm run typecheck
npm run lint
npm run build
```

### 需求對照

#### 1. `TaskComment` 型別至少有 id/text/authorName/authorId/createdAt

結果：**PASS**

`types.ts` 已新增：

- `id: string`
- `text: string`
- `authorName: string`
- `authorId: string`
- `createdAt: string`

#### 2. `Task` 有 `comments`

結果：**PASS**

`types.ts` 的 `Task` 介面已新增：

- `comments: TaskComment[]`

#### 3. 舊資料無 comments 時會 normalize 成 []

結果：**PASS**

`App.tsx` 已新增 `normalizeTask()`，會將：

- `tags` 非陣列時補為 `[]`
- `comments` 非陣列時補為 `[]`

且 `normalizeTaskOrders()` 會先對所有 task 執行 `normalizeTask()`；Firestore 讀取、初始化、更新保存都會經過 `normalizeProjects()` / `normalizeTaskOrders()`。

#### 4. 初始任務與新任務 comments 預設 []

結果：**PASS**

已確認：

- `INITIAL_PROJECTS` 內既有初始任務 `t1`、`t2` 均有 `comments: []`。
- `TaskModal` 新建任務 form state 預設 `comments: []`。
- `App.tsx` 建立新任務時使用 `comments: taskData.comments || []`。

#### 5. Modal 內可新增留言、空白不可送出、顯示作者與本地化時間戳、留言有 ISO timestamp

結果：**PASS**

`components/TaskModal.tsx` 已確認：

- 新增 `commentInput` state 與留言 textarea。
- `handleAddComment()` 會 `trim()` 留言內容；空白或未登入使用者會直接 return。
- 「送出留言」按鈕在 `!commentInput.trim()` 或 `!currentUser` 時 disabled。
- 新留言包含：
  - `id: comment-${Date.now()}-${...}`
  - `text`
  - `authorId: currentUser.uid`
  - `authorName: currentUser.displayName || currentUser.email || '未知使用者'`
  - `createdAt: new Date().toISOString()`
- UI 顯示留言作者名稱。
- UI 使用 `new Date(createdAt).toLocaleString('zh-TW', { hour12: false })` 顯示本地化時間戳。
- 留言依 `createdAt` 由舊到新排序顯示。

#### 6. 既有任務送出留言會寫回 onSave/Firestore，不必關閉 modal

結果：**PASS**

`TaskModal` 的 `handleAddComment()` 在 `initialData` 存在時會直接呼叫 `onSave(nextFormData)`，沒有呼叫 `onClose()`，因此既有任務送出留言後不需關閉 modal。

`App.tsx` 的 `saveTask()` 會更新目標 task，並呼叫 `updateProjects(newProjects)`；`updateProjects()` 會 normalize 後更新本地 state，且使用者登入時會 `setDoc(..., { merge: true })` 寫回 Firestore。

#### 7. TaskCard 顯示留言數量

結果：**PASS**

`components/TaskCard.tsx` 已新增：

- `MessageCircle` icon。
- `const commentCount = task.comments?.length || 0;`
- 當 `commentCount > 0` 時顯示「N 則留言」。

#### 8. 不破壞既有圖片/tags/assignee/date/manDays/DnD

結果：**PASS**

程式碼審查結果：

- 圖片：`TaskModal` 圖片上傳、預覽、移除流程保留；`TaskCard` 仍顯示 `task.imageUrl`。
- tags：新增/移除 tag 流程保留；`TaskCard` 仍顯示 tags；normalize 仍補 `tags: []`。
- assignee：Modal input 與 TaskCard 顯示保留。
- date：起始日/截止日 input 與 TaskCard 截止日顯示、急迫樣式保留。
- manDays：Modal input 與 TaskCard 顯示保留。
- DnD：`TaskCard` 仍接收 drag handle props；`SortableTaskCard` 仍透過 `useSortable` 傳入 `setActivatorNodeRef`、attributes/listeners；`KanbanColumn` 仍使用 `useDroppable` / `SortableContext`；`App.tsx` 的 `DndContext`、Sensors、DragOverlay 與 `handleDragEnd` 邏輯保留。

### 實際測試結果

已於 `/Users/macminix/work/AnttyKanban` 執行以下檢查：

- `npm run typecheck`：**PASS**
  - `tsc --noEmit` 成功，exit code 0。
- `npm run lint`：**PASS**
  - `eslint .` 成功，exit code 0。
- `npm run build`：**PASS**
  - Vite build 成功，exit code 0。
  - 輸出檔案：`dist/index.html`、`dist/assets/index-DpwBNjBZ.js`。
  - 非阻斷 warning：chunk size 超過 500 kB，訊息建議 dynamic import / manualChunks / chunkSizeWarningLimit。

### 問題清單

#### 阻斷問題

無。

#### 非阻斷觀察 / 建議

1. **Build chunk size warning**  
   `dist/assets/index-DpwBNjBZ.js` 約 779 kB，超過 Vite 預設 500 kB 建議門檻。此為建置警告，非本次留言功能造成的阻斷問題。

2. **留言功能目前依登入使用者資訊建立作者資料**  
   App 目前登入後才進入看板，因此合理；若未來支援未登入瀏覽/本機模式下留言，需要另行定義匿名留言策略。

### 最終判定

**PASS，可交由主 agent 進行後續流程。**

本 QA 僅更新 `QA_VERIFICATION_REPORT.md`，未進行 commit 或 push。

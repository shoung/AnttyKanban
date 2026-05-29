# AnttyKanban QA 驗證報告

## 結論

**整體結果：PASS**

本次 QA 以程式碼審查、git diff 檢查與實際 npm scripts 執行驗證為主。DnD 實作已改用 `@dnd-kit`，並涵蓋同欄排序、跨欄移動、空欄 drop、handle-only drag、拖曳中視覺回饋、鍵盤 Sensor 與基本 touch/mobile 處理。`typecheck` / `lint` / `format` scripts 已補上，且 `npm run typecheck`、`npm run lint`、`npm run build` 均通過。

未發現阻斷性問題；僅有 Vite chunk size warning 與幾個可再精進的非阻斷觀察項目。

## 驗證範圍

檢查檔案：

- `App.tsx`
- `components/KanbanColumn.tsx`
- `components/SortableTaskCard.tsx`
- `components/TaskCard.tsx`
- `types.ts`
- `package.json`
- `eslint.config.js`
- `.prettierrc`

額外觀察：

- `components/TaskModal.tsx`：確認任務新增、編輯、刪除入口仍存在。
- `package-lock.json`：因 `@dnd-kit` / ESLint / Prettier 相依套件更新而變更。

## 需求對照

### 1. 仿造成熟 Drag & Drop 函式庫體驗

結果：**PASS**

已確認使用 `@dnd-kit`，且關鍵元件與設定存在：

- `DndContext`：存在於 `App.tsx`。
- `PointerSensor`：存在於 `App.tsx`。
- `PointerSensor` activation distance：`distance: 8` 已設定。
- `KeyboardSensor`：存在於 `App.tsx`。
- `sortableKeyboardCoordinates`：已作為 `KeyboardSensor` 的 `coordinateGetter`。
- `SortableContext`：存在於 `components/KanbanColumn.tsx`。
- `useSortable`：存在於 `components/SortableTaskCard.tsx`。
- `useDroppable`：存在於 `components/KanbanColumn.tsx`。
- `DragOverlay`：存在於 `App.tsx`。

功能面檢查：

- 同欄排序：**PASS**  
  `handleDragEnd` 會依 active / over 重新組合同欄任務並重設 `order`。

- 跨欄移動：**PASS**  
  `handleDragEnd` 會辨識 `targetColumnId`，更新 moved task 的 `columnId`，並 normalize 來源欄與目標欄任務順序。

- 空欄 drop：**PASS**  
  `KanbanColumn` 使用 `useDroppable({ id: column.id })`，空欄仍可作為 drop target；空狀態文案會在拖曳時顯示「放開即可移至此欄」。

- Handle-only drag：**PASS**  
  `TaskCard` 的 DnD attributes/listeners 掛在 Grip handle button 上；卡片本體仍保留 `onClick={() => onEdit(task)}` 作為編輯入口。

- 拖曳中視覺回饋：**PASS**  
  包含 active task opacity/ring/scale、欄位 `isOver` ring/background、空欄提示、非空欄 drop hint，以及 `DragOverlay`。

- 拖曳動畫：**PASS**  
  `useSortable` 使用 `transform` / `transition`，`DragOverlay` 有 `dropAnimation`。

- 鍵盤可及性：**PASS**  
  已使用 `KeyboardSensor` + `sortableKeyboardCoordinates`，handle button 有 `aria-label` 與 focus-visible ring。

- Mobile / touch 相關處理：**PASS**  
  drag handle 有 `touch-none`，PointerSensor 使用 distance 8，可降低誤觸啟動拖曳。

### 2. 補 scripts：typecheck / lint / format

結果：**PASS**

`package.json` 已新增：

- `typecheck`: `tsc --noEmit`
- `lint`: `eslint .`
- `format`: `prettier --write .`

並新增：

- `eslint.config.js`
- `.prettierrc`

ESLint 設定包含 TypeScript、React Hooks、React Refresh 規則；Prettier 設定可正常支援專案格式化需求。

### 3. 既有功能回歸檢查

結果：**PASS**

- 任務點擊編輯：**PASS**  
  `TaskCard` 保留卡片本體 `onClick` 開啟編輯；drag handle 會 `stopPropagation()` 避免點 handle 時誤開 modal。

- 任務刪除：**PASS**  
  `deleteTask` 保留於 `App.tsx`，並透過 `TaskModal` 的 `onDelete={deleteTask}` 使用。TaskCard 本身不顯示刪除按鈕，但現有刪除流程仍在 modal 中。

- 任務新增：**PASS**  
  欄位 header 加號與欄底「新建卡片」按鈕皆呼叫 `onAddTask(column.id)`；新增時會計算目標欄下一個 `order`。

- 欄位編輯：**PASS**  
  欄位標題點擊編輯、blur / Enter commit、欄位顏色修改、欄位刪除皆保留於 `KanbanColumn` 與 `App.tsx` handlers。

- 專案/欄位/登入基本流程：**PASS**  
  專案新增、刪除、改名、登入/登出與 Firestore sync 相關 handlers 仍存在。

- Task order normalize：**PASS**  
  新增 `order` 欄位，讀取遠端資料、初始化資料、更新 projects 時皆會透過 `normalizeProjects` / `normalizeTaskOrders` 依欄位重新排序並補齊連續 order。這對舊資料缺少 `order` 的情境合理。

## 實際測試結果

已在 `/Users/macminix/work/AnttyKanban` 執行：

```bash
npm run typecheck
npm run lint
npm run build
```

結果：

- `npm run typecheck`：**PASS**
- `npm run lint`：**PASS**
- `npm run build`：**PASS**

Build 輸出：

- Vite build 成功。
- 產生 chunk size warning：`dist/assets/index-*.js` 約 775 kB，超過 500 kB 建議門檻。
- 此為非阻斷 warning，與主 agent 先前確認一致。

## 問題清單

### 阻斷問題

無。

### 非阻斷觀察 / 建議

1. **跨欄拖曳期間的 live placeholder 可再更接近成熟 DnD 體驗**  
   目前同欄排序可透過 `useSortable` transform/transition 呈現排序動畫；跨欄拖曳主要靠欄位 highlight、空欄提示、非空欄底部 hint 與 `DragOverlay`。若要更接近 Trello / Jira 類成熟體驗，可在 `onDragOver` 暫時更新 active task 所在欄位，讓目標欄在拖曳中即時騰出插入位置。

2. **同欄拖曳到某張卡片時採「插入到 over task 前方」邏輯**  
   `insertionIndex` 目前使用 `overTaskIndex`。這是合理排序策略之一，但若期望依滑鼠位置判斷插入前/後，可再依 collision data 或 pointer position 細分。

3. **Build chunk size warning**  
   非阻斷。若後續重視載入效能，可考慮 code splitting 或 manualChunks。

## 最終判定

**PASS，可交由主 agent 進行後續 commit / push 流程。**

本 QA 未進行 commit 或 push。

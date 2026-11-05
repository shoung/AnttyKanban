# Antty · 個人工作區

以 Firebase Google 登入共用「看板、心智圖、日曆、AI 接入」。每個帳號的看板與心智圖位於自己的 Firebase UID 命名空間。

## 本機開發

Node.js 22+。`npm ci` 後複製 `.env.example` 為 `.env.local`，填入自己的 Firebase 前端設定，再執行 `npm run dev`。`npm run build` 產生 Vite 靜態檔案；`api/` 為 Vercel Node functions，本機整合 API 請使用已授權設定的 Vercel 開發環境。不要把任何 server secret 放進 `VITE_` 變數。

- `npm test`：資料驗證、帳號隔離、OAuth、MCP、衝突等單元測試。
- `npm run test:ui`：心智圖編輯與非同步回歸、工作區導航、日曆介面。
- `npm run typecheck`、`npm run lint`、`npm run build`。
- Firestore/Storage 規則測試見 `security/MIGRATION.md` 與 `security/firebase.emulators.json`。只使用 demo project emulators。

## 工作區

**看板**：保留原有專案、狀態池、卡片、留言與附件操作。新的私人資料存於 `users/{uid}/boards/default`。Firestore transaction 檢查 revision，衝突或權限錯誤保留草稿並停止後續寫入，避免靜默覆蓋。

**心智圖**：React Flow 畫布，建立／開啟／搜尋、子節點／同層、拖曳重掛、折疊、復原／重做、自動儲存、JSON／Markdown 匯入匯出。沿用原心智圖編輯體驗，改用 Antty 的 Firebase 登入及 transaction。每圖最多 1000 個節點、32 層、512 KB。

**日曆**：另外明確同意連接 Google Calendar，與 Firebase 登入不同。操作本人 Google 主日曆；UI 和 MCP 都使用同一後端服務。個人一般事件可增刪改查；含與會者、週期、他人主辦或特殊類型的事件目前唯讀，避免誤寄通知或改整個系列。詳見 `docs/calendar-oauth.md`。未設定不影響 Firebase 登入及其他工作區。

**AI / hosted MCP**: `/api/mcp` uses scoped Streamable HTTP. The selected hosted flow uses existing Firebase login plus Antty-owned OAuth (authorization code/S256, exact public clients, resource-bound opaque tokens). Start with read-only synthetic mindmaps; hosted connection remains pending approved deployment/configuration and acceptance. See [Firebase MCP OAuth](docs/mcp-firebase-oauth.md). Auth0 onboarding is stopped. Calendar AI authorization remains separate from human Calendar access.

## 上線前必做

此分支不會自動搬移舊資料，也不會自動部署安全規則。

1. 確認實際部署的 Firestore 與 Storage rules。`security/*.rules.draft` 是需審核的草稿，不可不經查核覆蓋現有規則。不得留下可讀取所有路徑的舊廣泛 allow 規則，因為 allow 會取 OR。
2. 為 server functions 配置 Firebase Admin ADC，優先平台工作負載身分。需要新的 IAM／信任關係時先取得授權；不要提交 service-account JSON。
3. 配置 Google OAuth client、完全一致的 callback、Calendar API、加密金鑰、正式 consent 狀態及必要驗證。這些是部署時的權限／憑證動作，不是寫入程式碼就已完成。新 Calendar 連接需每個使用者親自同意。
4. 明確開啟 MCP 並配置應用來源，只有使用者在 UI 建立權杖後才有存取權。保護登入、API 和 token 發行端點的正式流量限制。
5. 先在隔離測試 Firebase 專案／預覽環境驗證跨帳號存取，再安排正式 rollout。不得讓預覽誤用正式資料做測試。
6. 舊 `boards/default` 與舊附件保留。使用者已確認舊看板屬於本人，仍必須先驗證其 Firebase UID、備份與雜湊，再使用 dry-run migration 工具，不能推測 UID 或覆寫新工作區。

既有獨立心智圖站與倉庫不會因本分支被刪除。資料匯入需另外選定來源，不能把歷史圖自動分配給任意帳號。

## 來源

心智圖 UI／模型移植自使用者的 `shoung/brainstorm-map` 提交 `db701aced8f737ffb2b4bcc10215afcf6872f895`，經使用者同意公開程式碼。React Flow 使用 `@xyflow/react`（MIT），未包含付費 Pro 範例。所有測試資料為合成資料，不包含真實日曆、看板、私鑰或 token。

## 相依套件安全檢查

此版本以相容修補版 overrides 更新 gRPC、protobufjs、websocket-driver，排除開發時檢出的 high／critical 公告。仍需在每次部署前重新執行 `npm audit --omit=dev`；目前 Google Cloud Firestore 間接依賴的 rimraf/glob/minimatch 鏈仍有 moderate 公告。不要以未測試的 major override 隱藏報告；升級後需重跑 emulator 與整合測試。

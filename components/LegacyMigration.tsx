import { useRef, useState } from 'react';
import type { User } from 'firebase/auth';
import { auth } from '../firebase';
import {
  applyLegacyMigration,
  loadLegacyMigration,
  verifyLegacyMigration,
} from '../services/legacyBrowserStore';

/** Explicit operator workflow, never an automatic first-login data claim. */
export function LegacyMigration({ user }: { user: User }) {
  const [loaded, setLoaded] = useState<Awaited<ReturnType<typeof loadLegacyMigration>> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('尚未讀取資料，不會自動匯入。');
  const [confirmedUid, setConfirmedUid] = useState('');
  const [downloaded, setDownloaded] = useState(false);
  const [backupChecked, setBackupChecked] = useState(false);
  const [attempted, setAttempted] = useState(() =>
    Boolean(sessionStorage.getItem(`antty-legacy-migration:${user.uid}`)),
  );
  const active = useRef(0);
  const owner = user.uid;
  const stillHere = (epoch: number) => active.current === epoch && auth.currentUser?.uid === owner;
  const load = async () => {
    const epoch = ++active.current;
    setBusy(true);
    setLoaded(null);
    setDownloaded(false);
    setBackupChecked(false);
    try {
      const result = await loadLegacyMigration(owner);
      if (!stillHere(epoch)) return;
      setLoaded(result);
      setMessage('已讀取來源與圖片清單。請先下載並檢查備份。');
    } catch (error) {
      if (stillHere(epoch)) setMessage(error instanceof Error ? error.message : '讀取失敗。');
    } finally {
      if (stillHere(epoch)) setBusy(false);
    }
  };
  const download = () => {
    if (!loaded || auth.currentUser?.uid !== owner) return;
    const { plan, images, targetStatus } = loaded;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            format: 'antty-legacy-backup-v1',
            projectId: loaded.projectId,
            storageBucket: loaded.storageBucket,
            capturedAt: new Date().toISOString(),
            ...plan,
            targetStatus,
            images,
            imagesAreMetadataOnly: true,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `antty-legacy-${plan.sourceHash}.backup.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(true);
  };
  const verify = async () => {
    if (!loaded) return;
    const epoch = ++active.current;
    setBusy(true);
    try {
      const result = await verifyLegacyMigration(owner, loaded.plan);
      if (!stillHere(epoch)) return;
      setMessage(
        result.targetStatus === 'verified' && result.sourceUnchanged
          ? '已驗證：新工作區內容相符，舊看板未變更。'
          : '遠端核對：目的地 ' +
              result.targetStatus +
              '；舊來源' +
              (result.sourceUnchanged ? '未變更' : '已變更') +
              '。停止提交，請人工核對。',
      );
    } catch (error) {
      if (stillHere(epoch))
        setMessage('尚無法確認結果，請勿重送。' + (error instanceof Error ? error.message : ''));
    } finally {
      if (stillHere(epoch)) setBusy(false);
    }
  };
  const submit = async () => {
    if (
      !loaded ||
      attempted ||
      busy ||
      !downloaded ||
      !backupChecked ||
      confirmedUid !== owner ||
      loaded.targetStatus !== 'absent' ||
      loaded.images.some((i) => i.status !== 'verified')
    )
      return;
    if (
      !window.confirm(
        '只將備份中的舊看板複製到目前確認帳號的新工作區，不修改舊資料。確定執行一次？',
      )
    )
      return;
    const epoch = ++active.current;
    setBusy(true);
    try {
      if (auth.currentUser?.uid !== owner) throw new Error('帳號已變更。');
      // Persist intent before submission; a reload never automatically enables a retry.
      sessionStorage.setItem(
        `antty-legacy-migration:${owner}`,
        JSON.stringify({
          sourceHash: loaded.plan.sourceHash,
          status: 'intent',
          at: new Date().toISOString(),
        }),
      );
      setAttempted(true);
      const result = await applyLegacyMigration(owner, loaded.plan);
      if (!stillHere(epoch)) return;
      if (result.targetStatus !== 'verified' || !result.sourceUnchanged)
        throw new Error('提交後核對不相符，停止並檢查遠端。');
      sessionStorage.setItem(
        `antty-legacy-migration:${owner}`,
        JSON.stringify({
          sourceHash: loaded.plan.sourceHash,
          status: 'verified',
          at: new Date().toISOString(),
        }),
      );
      setMessage('遷移成功並已讀回驗證。舊看板與所有原圖片均未修改。');
    } catch (error) {
      if (stillHere(epoch))
        setMessage(
          '未確認完成。請使用「核對遠端結果」，不要再次提交。' +
            (error instanceof Error ? error.message : ''),
        );
    } finally {
      if (stillHere(epoch)) setBusy(false);
    }
  };
  return (
    <main className="max-w-3xl mx-auto p-8 space-y-5">
      <h1 className="text-2xl font-bold">舊看板備份與一次性匯入</h1>
      <p>
        目前帳號：{user.email || '未提供 email'}
        <br />
        Firebase UID：<span className="font-mono break-all">{owner}</span>
      </p>
      <p className="text-sm">
        只處理你確認擁有的舊共用看板。先下載完整資料備份，再核對圖片與目的地；不覆寫既有新看板、不移除舊資料。圖片清單只備份參照及物件資訊，不包含圖片二進位檔。
      </p>
      <button disabled={busy} onClick={load}>
        讀取舊看板與圖片清單（不寫入）
      </button>
      {loaded && (
        <section className="space-y-3 border rounded p-4">
          <p>
            {loaded.plan.counts.projects} 個專案、{loaded.plan.counts.tasks} 個任務、
            {loaded.plan.counts.comments} 則留言、{loaded.plan.counts.images} 個圖片參照。
          </p>
          <p>
            目的地：
            {loaded.targetStatus === 'absent'
              ? '已確認不存在，可建立'
              : loaded.targetStatus === 'exists'
                ? '已存在，禁止覆寫'
                : '無法確認權限，目前只能備份'}
          </p>
          <p className="text-xs break-all">來源 SHA-256：{loaded.plan.sourceHash}</p>
          <ul>
            {loaded.images.map((image, i) => (
              <li key={i}>
                {image.path || '只有舊圖片網址'}：
                {image.status === 'verified' ? `已確認 ${image.size} bytes` : '尚未確認，停止匯入'}
              </li>
            ))}
          </ul>
          <button disabled={busy} onClick={download}>
            下載完整 JSON 備份
          </button>
          <label className="block">
            <input
              type="checkbox"
              disabled={!downloaded || busy}
              checked={backupChecked}
              onChange={(e) => setBackupChecked(e.target.checked)}
            />{' '}
            我已確認備份檔已下載、可讀，來源內容與圖片清單正確。
          </label>
          <label className="block">
            輸入已核實的目的 UID：
            <input
              className="border ml-2"
              aria-label="確認目的 UID"
              value={confirmedUid}
              disabled={busy}
              onChange={(e) => setConfirmedUid(e.target.value)}
            />
          </label>
          <button
            disabled={
              busy ||
              attempted ||
              !downloaded ||
              !backupChecked ||
              confirmedUid !== owner ||
              loaded.targetStatus !== 'absent' ||
              loaded.images.some((i) => i.status !== 'verified')
            }
            onClick={submit}
          >
            建立新工作區副本（只提交一次）
          </button>
          <button className="ml-4" disabled={busy} onClick={verify}>
            核對遠端結果（不寫入）
          </button>
        </section>
      )}
      <p role="status" className="whitespace-pre-wrap">
        {busy ? '處理中…' : message}
      </p>
      <a className="block underline" href="/">
        返回 Antty
      </a>
    </main>
  );
}

import { useEffect, useState, type ImgHTMLAttributes } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { getBlob, ref } from 'firebase/storage';
import { auth, storage } from '../firebase';
import { attachmentSource } from '../services/boardSafety';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  imagePath?: string;
  imageUrl?: string;
};
/** New attachments use authenticated reads. Legacy URLs remain compatible, never as a private-path fallback. */
export function SecureTaskImage({ imagePath, imageUrl, alt, ...props }: Props) {
  const [source, setSource] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let epoch = 0;
    let objectUrl: string | null = null;
    const clear = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      const current = ++epoch;
      clear();
      setSource(null);
      setFailed(false);
      const selected = attachmentSource(user?.uid ?? null, imagePath, imageUrl);
      if (selected.kind === 'legacy') {
        setSource(selected.url);
        return;
      }
      if (selected.kind === 'none') {
        setFailed(true);
        return;
      }
      try {
        const blob = await getBlob(ref(storage, selected.path), 10 * 1024 * 1024);
        if (current !== epoch || auth.currentUser?.uid !== user?.uid) return;
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
      } catch {
        if (current === epoch) setFailed(true);
      }
    });
    return () => {
      epoch++;
      unsubscribe();
      clear();
    };
  }, [imagePath, imageUrl]);
  if (!source)
    return (
      <span className="block p-3 text-xs text-slate-500" role="status">
        {failed ? '圖片目前無法讀取' : '圖片載入中…'}
      </span>
    );
  return <img {...props} src={source} alt={alt || '任務圖片'} />;
}

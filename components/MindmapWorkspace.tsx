import { useCallback } from 'react';
import type { User } from 'firebase/auth';
import Workspace from '../mindmap/components/Workspace';
import { mapRequest } from '../services/mapStore';
import '../mindmap/style.css';
export default function MindmapWorkspace({
  user,
  onDirtyChange,
}: {
  user: User;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const request = useCallback(
    <T,>(url: string, init?: RequestInit) => mapRequest<T>(user.uid, url, init),
    [user.uid],
  );
  return (
    <div className="mindmap-scope">
      <Workspace key={user.uid} request={request} onDirtyChange={onDirtyChange} />
    </div>
  );
}

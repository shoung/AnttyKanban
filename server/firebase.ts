import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { bearerToken, enforceUid } from './authPolicy';
function adminApp() {
  const existing = getApps().find((app) => app.name === 'antty-server');
  if (existing) return existing;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId)
    throw Object.assign(new Error('Server Firebase is not configured'), { status: 503 });
  // ADC can use platform workload identity. Never expose credentials to the Vite client.
  return initializeApp({ credential: applicationDefault(), projectId }, 'antty-server');
}
export const getAdminAuth = () => getAuth(adminApp());
export const getAdminDb = () => getFirestore(adminApp());
export async function authenticateRequest(req: {
  headers: { authorization?: string | string[] };
}): Promise<{ uid: string }> {
  const token = bearerToken(req.headers.authorization);
  try {
    const decoded = await getAdminAuth().verifyIdToken(token, true);
    return { uid: enforceUid(decoded.uid) };
  } catch (error) {
    if ((error as { status?: number }).status === 503) throw error;
    throw Object.assign(new Error('Authentication required'), { status: 401 });
  }
}

import {
  adminCredential,
  isCredentialUnavailable,
  adminAuthMode,
  wifAuthClient,
  wifConfiguration,
} from './adminCredentials.js';
import { Firestore } from '@google-cloud/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { bearerToken, enforceUid } from './authPolicy.js';
function adminApp() {
  const existing = getApps().find((app) => app.name === 'antty-server');
  if (existing) return existing;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId)
    throw Object.assign(new Error('Server Firebase is not configured'), { status: 503 });
  // Production requires explicit Vercel WIF. Local ADC is opt-in, never an automatic fallback.
  return initializeApp({ credential: adminCredential(), projectId }, 'antty-server');
}
export const getAdminAuth = () => getAuth(adminApp());
let database: Firestore | undefined;
export function getAdminDb(): Firestore {
  if (database) return database;
  // Firebase Admin Firestore rejects custom Credentials. Pass the supported Google
  // auth client directly to Firestore instead; never fall back to ambient ADC.
  if (adminAuthMode() === 'vercel-wif') {
    const config = wifConfiguration();
    database = new Firestore({ projectId: config.projectId, authClient: wifAuthClient(config) });
  } else {
    database = getFirestore(adminApp());
  }
  return database;
}
export async function authenticateRequest(req: {
  headers: { authorization?: string | string[] };
}): Promise<{ uid: string }> {
  const token = bearerToken(req.headers.authorization);
  try {
    const decoded = await getAdminAuth().verifyIdToken(token, true);
    return { uid: enforceUid(decoded.uid) };
  } catch (error) {
    if (isCredentialUnavailable(error))
      throw Object.assign(new Error('Backend credentials unavailable'), { status: 503 });
    throw Object.assign(new Error('Authentication required'), { status: 401 });
  }
}

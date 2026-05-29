import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const env = (import.meta as any).env || {};

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || "AIzaSyCRzy53zu-xz-3qe4qtJN3LuLWx3gsxMwg",
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || "antboard-2025.firebaseapp.com",
  projectId: env.VITE_FIREBASE_PROJECT_ID || "antboard-2025",
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || "antboard-2025.firebasestorage.app",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || "376367007034",
  appId: env.VITE_FIREBASE_APP_ID || "1:376367007034:web:fdd96864c9d9603e20fc03",
  measurementId: env.VITE_FIREBASE_MEASUREMENT_ID || "G-JMC7203YRN"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const storage = getStorage(app);
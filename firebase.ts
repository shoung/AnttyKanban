import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCRzy53zu-xz-3qe4qtJN3LuLWx3gsxMwg",
  authDomain: "antboard-2025.firebaseapp.com",
  projectId: "antboard-2025",
  storageBucket: "antboard-2025.firebasestorage.app",
  messagingSenderId: "376367007034",
  appId: "1:376367007034:web:fdd96864c9d9603e20fc03",
  measurementId: "G-JMC7203YRN"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
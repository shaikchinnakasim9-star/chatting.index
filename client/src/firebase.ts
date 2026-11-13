import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDatabase } from "firebase/database";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const required = [
  "VITE_FIREBASE_API_KEY",
  "VITE_FIREBASE_AUTH_DOMAIN",
  "VITE_FIREBASE_PROJECT_ID",
  "VITE_FIREBASE_STORAGE_BUCKET",
  "VITE_FIREBASE_MESSAGING_SENDER_ID",
  "VITE_FIREBASE_APP_ID",
] as const;

const missing = required.filter((key) => !import.meta.env[key]);
if (missing.length) {
  throw new Error(`Missing Firebase configuration: ${missing.join(", ")}. Copy client/.env.example to client/.env and fill in your Firebase web app values.`);
}

const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID.trim();
if (projectId !== "gather-869c5") {
  throw new Error(`Gather must connect to Firebase project gather-869c5; the configured project is "${projectId}".`);
}

const app = getApps().length ? getApp() : initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const realtimeDb = import.meta.env.VITE_FIREBASE_DATABASE_URL
  ? getDatabase(app, import.meta.env.VITE_FIREBASE_DATABASE_URL)
  : null;

import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_PROJECT_ID?.trim()
  || process.env.GCLOUD_PROJECT?.trim()
  || process.env.GCP_PROJECT?.trim();

if (!projectId) {
  throw new Error("FIREBASE_PROJECT_ID is required. Set it in server/.env before starting the API.");
}
if (projectId !== "gather-869c5") {
  throw new Error(`Gather must connect to Firebase project gather-869c5; the configured project is "${projectId}".`);
}

const app = getApps()[0] ?? initializeApp({
  credential: applicationDefault(),
  projectId,
});

export const auth = getAuth(app);
export const db = getFirestore(app);

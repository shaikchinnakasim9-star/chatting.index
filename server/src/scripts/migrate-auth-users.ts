import "dotenv/config";
import { createHash } from "node:crypto";
import { FieldValue, Timestamp, type DocumentData } from "firebase-admin/firestore";
import type { UserRecord } from "firebase-admin/auth";
import { auth, db } from "../config/firebase.js";

const expectedProjectId = "gather-869c5";
const projectId = process.env.FIREBASE_PROJECT_ID?.trim()
  || process.env.GCLOUD_PROJECT?.trim()
  || process.env.GCP_PROJECT?.trim();
const applyChanges = process.argv.includes("--apply");
const pageSize = 1000;
const chunkSize = 200;

type DocumentStats = { created: number; updated: number; skipped: number };
const userStats: DocumentStats = { created: 0, updated: 0, skipped: 0 };
const publicStats: DocumentStats = { created: 0, updated: 0, skipped: 0 };

function stringValue(...values: unknown[]) {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim() ?? "";
}

function safeDefaultUsername(uid: string) {
  const suffix = createHash("sha256").update(uid).digest("hex").slice(0, 24);
  return `user-${suffix}`;
}

function usernameValue(...values: unknown[]) {
  return values.find((value): value is string =>
    typeof value === "string" && /^[a-zA-Z0-9._-]{2,32}$/.test(value.trim()),
  )?.trim() ?? "";
}

function asTimestamp(value: unknown): value is Timestamp {
  return value instanceof Timestamp;
}

function authTimestamp(value: string | undefined, fallback: Timestamp) {
  if (!value) return fallback;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? Timestamp.fromMillis(milliseconds) : fallback;
}

function prefixes(name: string) {
  return [...new Set(name.toLowerCase().split(/\s+/).flatMap((part) =>
    Array.from({ length: Math.max(0, part.length - 1) }, (_unused, index) => part.slice(0, index + 2)),
  ))];
}

function validField(data: DocumentData, key: string, value: unknown) {
  if (!Object.hasOwn(data, key)) return false;
  if (["createdAt", "lastSeen"].includes(key)) return asTimestamp(data[key]);
  if (key === "isOnline" || key === "online") return typeof data[key] === "boolean";
  if (key.endsWith("Prefixes")) return Array.isArray(data[key]);
  if (typeof value === "string") {
    return typeof data[key] === "string"
      && (!["uid", "username", "fullName", "displayName"].includes(key) || data[key].trim().length > 0);
  }
  return data[key] !== undefined;
}

function missingFields(existing: DocumentData, candidate: DocumentData) {
  return Object.fromEntries(Object.entries(candidate).filter(([key, value]) => !validField(existing, key, value)));
}

function recordDocument(stats: DocumentStats, existed: boolean, update: DocumentData) {
  if (!existed) stats.created += 1;
  else if (Object.keys(update).length) stats.updated += 1;
  else stats.skipped += 1;
}

async function migrateChunk(users: UserRecord[]) {
  const references = users.flatMap((user) => [
    db.collection("users").doc(user.uid),
    db.collection("publicProfiles").doc(user.uid),
  ]);
  const snapshots = await db.getAll(...references);
  const batch = db.batch();
  let writeCount = 0;

  for (let index = 0; index < users.length; index += 1) {
    const user = users[index];
    const privateSnapshot = snapshots[index * 2];
    const publicSnapshot = snapshots[index * 2 + 1];
    const privateData = privateSnapshot.data() ?? {};
    const publicData = publicSnapshot.data() ?? {};
    const email = stringValue(privateData.email, user.email);
    const fullName = stringValue(
      privateData.displayName,
      privateData.fullName,
      publicData.displayName,
      publicData.fullName,
      user.displayName,
      email.split("@")[0],
    ) || "Gather member";
    const username = usernameValue(privateData.username, publicData.username)
      || safeDefaultUsername(user.uid);
    const photoURL = stringValue(
      privateData.photoURL,
      privateData.profilePicture,
      publicData.photoURL,
      publicData.profilePicture,
      user.photoURL,
    );
    const createdAt = (asTimestamp(privateData.createdAt) && privateData.createdAt)
      || (asTimestamp(publicData.createdAt) && publicData.createdAt)
      || authTimestamp(user.metadata.creationTime, Timestamp.now());
    const lastSeen = (asTimestamp(privateData.lastSeen) && privateData.lastSeen)
      || (asTimestamp(publicData.lastSeen) && publicData.lastSeen)
      || authTimestamp(user.metadata.lastSignInTime, createdAt);
    const isOnline = typeof privateData.isOnline === "boolean"
      ? privateData.isOnline
      : typeof privateData.online === "boolean"
        ? privateData.online
        : typeof publicData.isOnline === "boolean"
          ? publicData.isOnline
          : typeof publicData.online === "boolean"
            ? publicData.online
            : false;
    const namePrefixes = prefixes(fullName);
    const privateCandidate = {
      uid: user.uid,
      username,
      usernameLower: username.toLowerCase(),
      fullName,
      fullNameLower: fullName.toLowerCase(),
      fullNamePrefixes: namePrefixes,
      displayName: fullName,
      displayNameLower: fullName.toLowerCase(),
      displayNamePrefixes: namePrefixes,
      email,
      emailLower: email.toLowerCase(),
      photoURL,
      profilePicture: photoURL,
      about: stringValue(privateData.about, publicData.about),
      isOnline,
      online: isOnline,
      lastSeen,
      createdAt,
    };
    const publicCandidate = {
      uid: user.uid,
      username,
      usernameLower: username.toLowerCase(),
      fullName,
      fullNameLower: fullName.toLowerCase(),
      displayName: fullName,
      displayNameLower: fullName.toLowerCase(),
      photoURL,
      profilePicture: photoURL,
      about: stringValue(publicData.about, privateData.about),
      isOnline,
      online: isOnline,
      lastSeen,
      createdAt,
    };
    const privateUpdate = missingFields(privateData, privateCandidate);
    const publicUpdate = missingFields(publicData, publicCandidate);
    if (Object.hasOwn(publicData, "email")) publicUpdate.email = FieldValue.delete();
    if (Object.hasOwn(publicData, "emailLower")) publicUpdate.emailLower = FieldValue.delete();

    recordDocument(userStats, privateSnapshot.exists, privateUpdate);
    recordDocument(publicStats, publicSnapshot.exists, publicUpdate);

    if (Object.keys(privateUpdate).length) {
      batch.set(privateSnapshot.ref, privateUpdate, { merge: true });
      writeCount += 1;
    }
    if (Object.keys(publicUpdate).length) {
      batch.set(publicSnapshot.ref, publicUpdate, { merge: true });
      writeCount += 1;
    }
  }

  if (applyChanges && writeCount) await batch.commit();
  return { processed: users.length, writes: writeCount };
}

async function main() {
  if (projectId !== expectedProjectId) {
    throw new Error(`Refusing to migrate Firebase project "${projectId || "unset"}"; expected "${expectedProjectId}".`);
  }
  console.log(`Firebase Auth profile migration: project=${expectedProjectId}, mode=${applyChanges ? "APPLY" : "DRY RUN"}`);
  let pageToken: string | undefined;
  let processed = 0;

  do {
    const page = await auth.listUsers(pageSize, pageToken);
    for (let offset = 0; offset < page.users.length; offset += chunkSize) {
      const result = await migrateChunk(page.users.slice(offset, offset + chunkSize));
      processed += result.processed;
      console.log(`${applyChanges ? "Processed" : "Would process"} ${processed} users; ${result.writes} document writes ${applyChanges ? "committed" : "planned"} for this chunk.`);
    }
    pageToken = page.pageToken;
  } while (pageToken);

  console.log(JSON.stringify({
    projectId: expectedProjectId,
    mode: applyChanges ? "apply" : "dry-run",
    usersProcessed: processed,
    usersProfiles: userStats,
    publicProfiles: publicStats,
    profilesCreated: userStats.created + publicStats.created,
    profilesUpdated: userStats.updated + publicStats.updated,
    profilesSkipped: userStats.skipped + publicStats.skipped,
  }, null, 2));
}

main().catch((error: unknown) => {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "app/invalid-credential" || /could not load the default credentials/i.test(message)) {
    console.error("Firebase Admin credentials are unavailable. Configure GOOGLE_APPLICATION_CREDENTIALS or Application Default Credentials for a service account with Firebase Authentication list and Firestore read/write permissions.");
  }
  console.error("Firebase Auth profile migration failed:", message);
  process.exitCode = 1;
});

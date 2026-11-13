import type { User } from "firebase/auth";
import { deleteField, doc, getDoc, serverTimestamp, setDoc, Timestamp } from "firebase/firestore";
import { db } from "../firebase";

type ProfileChanges = {
  fullName?: string;
  username?: string;
  profilePicture?: string;
  about?: string;
};

function storedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function defaultUsername(fullName: string, email: string, uid: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
  const name = normalize(email.split("@")[0] || fullName);
  return name.length >= 2 ? name : `user${uid.slice(0, 8).toLowerCase()}`;
}

export async function syncUserProfile(user: User, changes: ProfileChanges = {}) {
  if (!user.uid) throw new Error("Cannot synchronize a Firebase profile without an authenticated UID.");

  const userRef = doc(db, "users", user.uid);
  const publicRef = doc(db, "publicProfiles", user.uid);
  try {
    const [userSnapshot, publicSnapshot] = await Promise.all([getDoc(userRef), getDoc(publicRef)]);
    const account = userSnapshot.data() ?? {};
    const publicProfile = publicSnapshot.data() ?? {};
    const email = user.email || storedString(account.email);
    const fullName = changes.fullName?.trim()
      || storedString(account.fullName)
      || storedString(account.displayName)
      || storedString(publicProfile.fullName)
      || storedString(publicProfile.displayName)
      || user.displayName?.trim()
      || email.split("@")[0]
      || "Gather member";
    const username = changes.username?.trim()
      || storedString(account.username)
      || storedString(publicProfile.username)
      || defaultUsername(fullName, email, user.uid);
    const profilePicture = changes.profilePicture !== undefined
      ? changes.profilePicture.trim()
      : storedString(account.profilePicture)
        || storedString(account.photoURL)
        || storedString(publicProfile.profilePicture)
        || storedString(publicProfile.photoURL)
        || user.photoURL
        || "";
    const about = changes.about !== undefined
      ? changes.about.trim()
      : storedString(account.about) || storedString(publicProfile.about);
    const namePrefixes = [...new Set(fullName.toLowerCase().split(/\s+/).flatMap((part) =>
      Array.from({ length: Math.max(0, part.length - 1) }, (_unused, index) => part.slice(0, index + 2)),
    ))];
    const storedOnline = typeof account.isOnline === "boolean"
      ? account.isOnline
      : typeof account.online === "boolean"
        ? account.online
        : typeof publicProfile.isOnline === "boolean"
          ? publicProfile.isOnline
          : typeof publicProfile.online === "boolean"
            ? publicProfile.online
            : false;
    const storedLastSeen = account.lastSeen instanceof Timestamp
      ? account.lastSeen
      : publicProfile.lastSeen instanceof Timestamp
        ? publicProfile.lastSeen
        : serverTimestamp();
    const userCreatedAt = account.createdAt instanceof Timestamp
      ? account.createdAt
      : publicProfile.createdAt instanceof Timestamp
        ? publicProfile.createdAt
        : serverTimestamp();
    const publicCreatedAt = publicProfile.createdAt instanceof Timestamp
      ? publicProfile.createdAt
      : account.createdAt instanceof Timestamp
        ? account.createdAt
        : serverTimestamp();

    await Promise.all([
      setDoc(userRef, {
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
        profilePicture,
        photoURL: profilePicture,
        about,
        ...(!userSnapshot.exists() || typeof account.isOnline !== "boolean" ? { isOnline: userSnapshot.exists() ? storedOnline : false } : {}),
        ...(!userSnapshot.exists() || typeof account.online !== "boolean" ? { online: userSnapshot.exists() ? storedOnline : false } : {}),
        ...(!userSnapshot.exists() || !(account.lastSeen instanceof Timestamp) ? { lastSeen: storedLastSeen } : {}),
        createdAt: userCreatedAt,
      }, { merge: true }),
      setDoc(publicRef, {
        uid: user.uid,
        username,
        usernameLower: username.toLowerCase(),
        fullName,
        fullNameLower: fullName.toLowerCase(),
        displayName: fullName,
        displayNameLower: fullName.toLowerCase(),
        profilePicture,
        photoURL: profilePicture,
        about,
        ...(!publicSnapshot.exists() || typeof publicProfile.isOnline !== "boolean" ? { isOnline: publicSnapshot.exists() ? storedOnline : false } : {}),
        ...(!publicSnapshot.exists() || typeof publicProfile.online !== "boolean" ? { online: publicSnapshot.exists() ? storedOnline : false } : {}),
        ...(!publicSnapshot.exists() || !(publicProfile.lastSeen instanceof Timestamp) ? { lastSeen: storedLastSeen } : {}),
        createdAt: publicCreatedAt,
        ...(publicProfile.email === undefined ? {} : { email: deleteField() }),
        ...(publicProfile.emailLower === undefined ? {} : { emailLower: deleteField() }),
      }, { merge: true }),
    ]);
  } catch (issue) {
    const code = typeof issue === "object" && issue !== null && "code" in issue
      ? String(issue.code)
      : "unknown";
    const message = issue instanceof Error ? issue.message : String(issue);
    console.error("Firestore profile synchronization failed:", { code, message });
    if (code === "permission-denied") {
      throw new Error("Firestore denied access to your profile documents. Deploy rules that allow the signed-in UID to read and write users/{uid} and publicProfiles/{uid}, and verify the app uses the intended Firebase project.");
    }
    if (code === "unavailable" || code === "network-request-failed" || /failed to fetch/i.test(message)) {
      throw new Error("Could not reach Cloud Firestore while synchronizing your profile. Check your connection, Firebase project configuration, and Firestore service status.");
    }
    throw new Error(`Could not synchronize your Firestore profile (${code}): ${message}`);
  }
}

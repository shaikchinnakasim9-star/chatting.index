import {
  collection, doc, limit, onSnapshot, orderBy, query, where, type DocumentData,
} from "firebase/firestore";
import { db } from "../firebase";
import type { User } from "firebase/auth";

export type Profile = {
  uid: string;
  displayName: string;
  username?: string;
  email?: string;
  photoURL?: string;
  about?: string;
  shareEmail?: boolean;
  online?: boolean;
  lastSeen?: { toDate: () => Date } | string | null;
};

export type Conversation = {
  id: string;
  type: "direct" | "group";
  members: string[];
  admins?: string[];
  name?: string;
  photoURL?: string;
  lastMessage?: { text?: string; senderId?: string } | null;
  updatedAt?: { toDate: () => Date };
};

export type Message = {
  id: string;
  senderId: string;
  text: string;
  type: "text" | "image" | "document" | "voice";
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  durationSeconds?: number;
  deliveredBy?: string[];
  readBy?: string[];
  edited?: boolean;
  createdAt?: { toDate: () => Date };
};
export type NotificationItem = { id: string; conversationId: string; read: boolean; message: string };

const toData = (doc: DocumentData) => doc.data();

export function isProfileOnline(profile?: Profile) {
  if (!profile?.online || !profile.lastSeen) return false;
  const lastSeen = typeof profile.lastSeen === "string"
    ? Date.parse(profile.lastSeen)
    : profile.lastSeen.toDate().getTime();
  return Number.isFinite(lastSeen) && Date.now() - lastSeen < 120_000;
}

export function watchConversations(user: User, callback: (items: Conversation[]) => void, onError: (error: Error) => void) {
  const q = query(collection(db, "conversations"), where("members", "array-contains", user.uid), orderBy("updatedAt", "desc"), limit(100));
  return onSnapshot(q, (snapshot) => {
    const items = snapshot.docs.map((doc) => ({ id: doc.id, ...toData(doc) } as Conversation));
    items.sort((a, b) => (b.updatedAt?.toDate().getTime() ?? 0) - (a.updatedAt?.toDate().getTime() ?? 0));
    callback(items);
  }, onError);
}

export function watchMessages(conversationId: string, callback: (items: Message[]) => void, onError: (error: Error) => void) {
  const q = query(collection(db, "conversations", conversationId, "messages"), orderBy("createdAt", "desc"), limit(100));
  return onSnapshot(q, (snapshot) => {
    callback(snapshot.docs.map((doc) => ({ id: doc.id, ...toData(doc) } as Message)).reverse());
  }, onError);
}

export function watchProfiles(uids: string[], callback: (profiles: Profile[]) => void, onError: (error: Error) => void) {
  const profiles = new Map<string, Profile>();
  const listeners = uids.map((uid) => onSnapshot(doc(db, "publicProfiles", uid), (snapshot) => {
    if (snapshot.exists()) profiles.set(uid, snapshot.data() as Profile);
    else profiles.delete(uid);
    callback([...profiles.values()]);
  }, onError));
  callback([]);
  return () => listeners.forEach((unsubscribe) => unsubscribe());
}

export function watchNotifications(uid: string, callback: (items: NotificationItem[]) => void, onError: (error: Error) => void) {
  const q = query(collection(db, "notifications"), where("userId", "==", uid), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snapshot) => callback(snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as NotificationItem))), onError);
}

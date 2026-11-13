import {
  collection, doc, onSnapshot, orderBy, query, Timestamp, where, type DocumentData,
} from "firebase/firestore";
import { db } from "../firebase";
import type { User } from "firebase/auth";

export type Profile = {
  uid: string;
  displayName: string;
  fullName?: string;
  username?: string;
  photoURL?: string;
  profilePicture?: string;
  about?: string;
  online?: boolean;
  isOnline?: boolean;
  lastSeen?: { toDate: () => Date } | string | null;
};

export type Conversation = {
  id: string;
  type: "direct" | "group";
  storagePath?: "chats" | "conversations";
  members: string[];
  admins?: string[];
  name?: string;
  photoURL?: string;
  lastMessage?: { text?: string; senderId?: string } | null;
  updatedAt?: { toDate: () => Date };
  expiresAt?: { toDate: () => Date };
};

export type Message = {
  id: string;
  senderId: string;
  receiverId?: string;
  status?: "sent" | "delivered" | "read";
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
  expiresAt?: { toDate: () => Date };
};
export type NotificationItem = { id: string; conversationId: string; read?: boolean; message: string; type?: string };

const toData = (doc: DocumentData) => doc.data();

export function isProfileOnline(profile?: Profile) {
  return Boolean(profile?.isOnline ?? profile?.online);
}

export function watchPublicProfiles(callback: (profiles: Profile[]) => void, onError: (error: Error) => void) {
  return onSnapshot(query(collection(db, "publicProfiles")), (snapshot) => {
    callback(snapshot.docs.map((item) => {
      const data = item.data();
      const fullName = typeof data.fullName === "string" ? data.fullName : data.displayName;
      return {
        ...data,
        uid: item.id,
        displayName: typeof data.displayName === "string" ? data.displayName : fullName,
        fullName,
        photoURL: typeof data.photoURL === "string" ? data.photoURL : data.profilePicture,
      } as Profile;
    }));
  }, onError);
}

export function watchConversations(user: User, callback: (items: Conversation[]) => void, onError: (error: Error) => void) {
  let existingItems: Conversation[] = [];
  let directItems: Conversation[] = [];
  const emit = () => {
    const items = new Map(existingItems.map((item) => [item.id, item]));
    directItems.forEach((item) => items.set(item.id, item));
    callback([...items.values()].sort((a, b) => (b.updatedAt?.toDate().getTime() ?? 0) - (a.updatedAt?.toDate().getTime() ?? 0)));
  };
  const activeAfter = Timestamp.now();
  const existingQuery = query(collection(db, "conversations"),
    where("members", "array-contains", user.uid), where("expiresAt", ">", activeAfter),
    orderBy("expiresAt"), orderBy("updatedAt", "desc"));
  const directQuery = query(collection(db, "chats"),
    where("participants", "array-contains", user.uid), where("expiresAt", ">", activeAfter),
    orderBy("expiresAt"), orderBy("updatedAt", "desc"));
  const unsubscribeExisting = onSnapshot(existingQuery, (snapshot) => {
    existingItems = snapshot.docs.map((item) => ({ id: item.id, ...toData(item), storagePath: "conversations" } as Conversation));
    emit();
  }, onError);
  const unsubscribeDirect = onSnapshot(directQuery, (snapshot) => {
    directItems = snapshot.docs.map((item) => {
      const data = toData(item);
      return { id: item.id, ...data, type: "direct", members: data.participants, storagePath: "chats" } as Conversation;
    });
    emit();
  }, onError);
  return () => {
    unsubscribeExisting();
    unsubscribeDirect();
  };
}

export function watchMessages(conversationId: string, storagePath: Conversation["storagePath"], callback: (items: Message[]) => void, onError: (error: Error) => void) {
  const q = query(collection(db, storagePath ?? "conversations", conversationId, "messages"),
    where("expiresAt", ">", Timestamp.now()), orderBy("expiresAt"), orderBy("createdAt", "desc"));
  return onSnapshot(q, (snapshot) => {
    const activeMessages = snapshot.docs
      .map((item) => ({ id: item.id, ...toData(item) } as Message))
      .filter((message) => !message.expiresAt || message.expiresAt.toDate().getTime() > Date.now())
      .sort((left, right) => (left.createdAt?.toDate().getTime() ?? 0) - (right.createdAt?.toDate().getTime() ?? 0));
    callback(activeMessages.slice(-100));
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

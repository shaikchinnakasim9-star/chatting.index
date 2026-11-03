import { Router } from "express";
import { createHash } from "node:crypto";
import type { UserRecord } from "firebase-admin/auth";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { auth, db } from "../config/firebase.js";
import { authenticate } from "../middleware/authenticate.js";

export const api = Router();
api.use(authenticate);

let authUsersCache: { expiresAt: number; users: UserRecord[] } | undefined;
let authUsersRequest: Promise<UserRecord[]> | undefined;

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  username: z.string().trim().regex(/^[a-zA-Z0-9._-]{2,32}$/).optional(),
  photoURL: z.string().url().max(2048).or(z.literal("")).optional(),
  about: z.string().trim().max(300).optional(),
  shareEmail: z.boolean().optional(),
});
const conversationSchema = z.object({
  type: z.enum(["direct", "group"]),
  members: z.array(z.string().min(1).max(128)).min(1).max(100),
  name: z.string().trim().max(100).optional(),
  photoURL: z.string().url().max(2048).or(z.literal("")).optional(),
});
const messageSchema = z.object({
  text: z.string().trim().max(10000).default(""),
  type: z.enum(["text", "image", "document", "voice"]).default("text"),
  filePath: z.string().min(1).max(1024).optional(),
  fileName: z.string().max(255).optional(),
  mimeType: z.enum(["audio/webm", "audio/mp4", "audio/ogg"]).optional(),
  durationSeconds: z.number().int().min(1).max(120).optional(),
}).superRefine((message, context) => {
  if (message.type !== "text" && !message.filePath) {
    context.addIssue({ code: "custom", path: ["filePath"], message: "Attachments need a valid file path." });
  }
  if (message.type === "text" && message.filePath) {
    context.addIssue({ code: "custom", path: ["filePath"], message: "Text messages cannot include a file path." });
  }
  if (message.type === "voice" && !message.mimeType) {
    context.addIssue({ code: "custom", path: ["mimeType"], message: "Voice messages need a supported audio format." });
  }
  if (message.type !== "voice" && (message.mimeType || message.durationSeconds)) {
    context.addIssue({ code: "custom", path: ["mimeType"], message: "Audio details are only valid for voice messages." });
  }
});

function validBody<T extends z.ZodType>(
  schema: T,
  body: unknown,
): { success: true; data: z.infer<T> } | { success: false; message: string } {
  const result = schema.safeParse(body);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, message: result.error.issues[0]?.message ?? "Invalid request." };
}

async function memberConversation(conversationId: string, uid: string) {
  const ref = db.collection("conversations").doc(conversationId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return null;
  const data = snapshot.data();
  if (!data || !Array.isArray(data.members) || !data.members.includes(uid)) return null;
  return { ref, data };
}

function defaultUsername(displayName: string, email: string, uid: string) {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
  const name = normalize(displayName);
  if (name.length >= 2) return name;
  const emailName = normalize(email.split("@")[0] ?? "");
  return emailName.length >= 2 ? emailName : `user${uid.slice(0, 8).toLowerCase()}`;
}

function displayNamePrefixes(displayName: string) {
  const prefixes = new Set<string>();
  const addPrefixes = (part: string) => {
    for (let length = 2; length <= part.length; length += 1) prefixes.add(part.slice(0, length));
  };
  addPrefixes(displayName.toLowerCase());
  for (const token of displayName.toLowerCase().split(/\s+/)) addPrefixes(token);
  return [...prefixes];
}

function storedValueMatches(current: unknown, expected: unknown) {
  if (Array.isArray(current) && Array.isArray(expected)) {
    return current.length === expected.length
      && current.every((value, index) => value === expected[index]);
  }
  return current === expected;
}

function matchesSearch(value: string | undefined, search: string) {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && (
    normalized.startsWith(search)
    || normalized.split(/\s+/).some((part) => part.startsWith(search))
  ));
}

async function listAuthenticatedUsers() {
  if (authUsersCache && authUsersCache.expiresAt > Date.now()) return authUsersCache.users;
  if (authUsersRequest) return authUsersRequest;
  authUsersRequest = (async () => {
    const users: UserRecord[] = [];
    let pageToken: string | undefined;
    do {
      const page = await auth.listUsers(1000, pageToken);
      users.push(...page.users);
      pageToken = page.pageToken;
    } while (pageToken);
    authUsersCache = { users, expiresAt: Date.now() + 30_000 };
    return users;
  })();
  try {
    return await authUsersRequest;
  } finally {
    authUsersRequest = undefined;
  }
}

async function syncProfileFromAuth(identity: UserRecord) {
  const accountRef = db.collection("users").doc(identity.uid);
  const publicRef = db.collection("publicProfiles").doc(identity.uid);
  const [accountSnapshot, publicSnapshot] = await db.getAll(accountRef, publicRef);
  const account = accountSnapshot.data() ?? {};
  const publicProfile = publicSnapshot.data() ?? {};
  const email = identity.email?.trim().toLowerCase();
  const displayName = identity.displayName?.trim()
    || (typeof account.displayName === "string" && account.displayName.trim())
    || (email ? email.split("@")[0] : "")
    || `Gather member ${identity.uid.slice(0, 6)}`;
  const oldUsername = typeof account.username === "string" ? account.username
    : typeof publicProfile.username === "string" ? publicProfile.username : "";
  const username = /^[a-zA-Z0-9._-]{2,32}$/.test(oldUsername)
    ? oldUsername
    : defaultUsername(displayName, email ?? "", identity.uid);
  const photoURL = identity.photoURL
    || (typeof account.photoURL === "string" ? account.photoURL : "")
    || (typeof publicProfile.photoURL === "string" ? publicProfile.photoURL : "");
  const about = typeof publicProfile.about === "string" ? publicProfile.about
    : typeof account.about === "string" ? account.about : "";
  const online = typeof account.online === "boolean" ? account.online
    : typeof publicProfile.online === "boolean" ? publicProfile.online : false;
  const lastSeen = account.lastSeen ?? publicProfile.lastSeen ?? null;
  const accountData = {
    uid: identity.uid,
    email: identity.email ?? "",
    emailLower: email ?? "",
    displayName,
    displayNameLower: displayName.toLowerCase(),
    displayNamePrefixes: displayNamePrefixes(displayName),
    username,
    usernameLower: username.toLowerCase(),
    photoURL,
    about,
    online,
    lastSeen,
    ...(accountSnapshot.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
  };
  const publicData = {
    uid: identity.uid,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    username,
    usernameLower: username.toLowerCase(),
    photoURL,
    about,
    online,
    lastSeen,
  };
  const accountNeedsRepair = Object.entries(accountData)
    .some(([key, value]) => key !== "createdAt" && !storedValueMatches(account[key], value));
  const publicNeedsRepair = Object.entries(publicData)
    .some(([key, value]) => !storedValueMatches(publicProfile[key], value));
  if (accountNeedsRepair || publicNeedsRepair) {
    const batch = db.batch();
    if (accountNeedsRepair) batch.set(accountRef, accountData, { merge: true });
    if (publicNeedsRepair) batch.set(publicRef, publicData, { merge: true });
    await batch.commit();
  }
  return { ...publicData, ...(typeof publicProfile.email === "string" ? { email: publicProfile.email } : {}) };
}

function isAuthUserNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    && error.code === "auth/user-not-found";
}

async function registeredProfile(uid: string) {
  let identity;
  try {
    identity = await auth.getUser(uid);
  } catch (error) {
    if (isAuthUserNotFound(error)) return null;
    throw error;
  }
  if (
    identity.uid !== uid
    || identity.disabled
    || !identity.emailVerified
    || !identity.email
  ) return null;
  const profile = await syncProfileFromAuth(identity);
  if (!z.string().email().safeParse(identity.email).success) return null;
  return profile;
}

api.post("/profile", async (req, res) => {
  const parsed = validBody(profileSchema, req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.message }); return; }
  const uid = req.user!.uid;
  const userRef = db.collection("users").doc(uid);
  const previous = await userRef.get();
  const previousUsername = previous.data()?.username;
  const username = parsed.data.username
    ?? (typeof previousUsername === "string" && /^[a-zA-Z0-9._-]{2,32}$/.test(previousUsername)
      ? previousUsername
      : defaultUsername(parsed.data.displayName, req.user!.email ?? "", uid));
  const usernameLower = username.toLowerCase();
  const profileBatch = db.batch();
  profileBatch.set(userRef, {
    uid,
    email: req.user!.email ?? "",
    emailLower: (req.user!.email ?? "").toLowerCase(),
    displayName: parsed.data.displayName,
    displayNameLower: parsed.data.displayName.toLowerCase(),
    displayNamePrefixes: displayNamePrefixes(parsed.data.displayName),
    username,
    usernameLower,
    photoURL: parsed.data.photoURL ?? "",
    about: parsed.data.about ?? previous.data()?.about ?? "",
    online: true,
    lastSeen: FieldValue.serverTimestamp(),
    ...(previous.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true });
  profileBatch.set(db.collection("publicProfiles").doc(uid), {
    uid,
    displayName: parsed.data.displayName,
    displayNameLower: parsed.data.displayName.toLowerCase(),
    username,
    usernameLower,
    photoURL: parsed.data.photoURL ?? "",
    about: parsed.data.about ?? previous.data()?.about ?? "",
    ...(parsed.data.shareEmail === undefined
      ? {}
      : parsed.data.shareEmail
        ? { email: req.user!.email ?? "" }
        : { email: FieldValue.delete() }),
    online: true,
    lastSeen: FieldValue.serverTimestamp(),
  }, { merge: true });
  await profileBatch.commit();
  authUsersCache = undefined;
  res.json({ ok: true });
});

api.get("/users", async (req, res) => {
  const search = String(req.query.search ?? "").trim().toLowerCase().slice(0, 80);
  if (search.length < 2) { res.json([]); return; }
  const prefix = search.startsWith("@") ? search.slice(1) : search;
  if (prefix.length < 2) { res.json([]); return; }
  try {
    const [identities, ...profileMatches] = await Promise.all([
      listAuthenticatedUsers(),
      ...([
        "usernameLower",
        "displayNameLower",
        "emailLower",
        "username",
        "displayName",
        "email",
      ] as const).map((field) => db.collection("users")
        .orderBy(field).startAt(prefix).endAt(`${prefix}\uf8ff`).get()),
      db.collection("users").where("displayNamePrefixes", "array-contains", prefix).get(),
    ]);
    const identitiesByUid = new Map(identities
      .filter((identity) => !identity.disabled && identity.emailVerified && identity.email)
      .map((identity) => [identity.uid, identity]));
    const candidates = new Set<string>();
    for (const identity of identitiesByUid.values()) {
      const fallbackUsername = defaultUsername(identity.displayName ?? "", identity.email ?? "", identity.uid);
      if (matchesSearch(identity.displayName, prefix)
        || matchesSearch(identity.email, prefix)
        || matchesSearch(fallbackUsername, prefix)) {
        candidates.add(identity.uid);
      }
    }
    for (const snapshot of profileMatches) {
      for (const account of snapshot.docs) {
        if (account.id !== req.user!.uid && identitiesByUid.has(account.id)) candidates.add(account.id);
      }
    }
    candidates.delete(req.user!.uid);

    const profiles = await Promise.all([...candidates].map(async (uid) => {
      const identity = identitiesByUid.get(uid);
      if (!identity) return null;
      const profile = await syncProfileFromAuth(identity);
      if (!matchesSearch(profile.username, prefix)
        && !matchesSearch(profile.displayName, prefix)
        && !matchesSearch(identity.email, prefix)) return null;
      return {
        ...profile,
        lastSeen: profile.lastSeen && typeof profile.lastSeen === "object" && "toDate" in profile.lastSeen
          ? (profile.lastSeen as { toDate: () => Date }).toDate().toISOString()
          : null,
      };
    }));
    res.json(profiles.filter((profile) => profile !== null));
  } catch (error) {
    console.error("Firebase user search failed:", {
      uid: req.user!.uid,
      search: prefix,
      code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
});

api.post("/session/logout", async (req, res) => {
  await auth.revokeRefreshTokens(req.user!.uid);
  res.status(204).end();
});

api.post("/presence", async (req, res) => {
  const parsed = z.object({ online: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid presence status." }); return; }
  const lastSeen = FieldValue.serverTimestamp();
  const updates = { online: parsed.data.online, lastSeen };
  const presenceBatch = db.batch();
  presenceBatch.set(db.collection("users").doc(req.user!.uid), updates, { merge: true });
  presenceBatch.set(db.collection("publicProfiles").doc(req.user!.uid), updates, { merge: true });
  await presenceBatch.commit();
  res.json({ ok: true });
});

api.post("/conversations", async (req, res) => {
  const parsed = validBody(conversationSchema, req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.message }); return; }
  const uid = req.user!.uid;
  const members = [...new Set([...parsed.data.members, uid])];
  if (members.length > 100) { res.status(400).json({ error: "Groups are limited to 100 members." }); return; }
  if (parsed.data.type === "direct" && members.length !== 2) {
    res.status(400).json({ error: "A direct conversation must have exactly two members." });
    return;
  }
  const memberProfiles = await Promise.all(members.map((member) => registeredProfile(member)));
  if (memberProfiles.some((profile) => profile === null)) {
    res.status(400).json({ error: "Every conversation member must have a verified Gather account." });
    return;
  }
  if (parsed.data.type === "group" && (!parsed.data.name || members.length < 2)) {
    res.status(400).json({ error: "Groups need a name and at least one other member." });
    return;
  }
  if (parsed.data.type === "direct") {
    const id = createHash("sha256").update([...members].sort().join(":")).digest("hex");
    const ref = db.collection("conversations").doc(id);
    const result = await db.runTransaction(async (transaction) => {
      const existingChats = await transaction.get(db.collection("conversations")
        .where("type", "==", "direct")
        .where("members", "array-contains", uid));
      const requestedMembers = [...members].sort();
      const existingChat = existingChats.docs.find((chat) => {
        const chatMembers = chat.data().members;
        return Array.isArray(chatMembers)
          && chatMembers.length === 2
          && [...chatMembers].sort().every((member, index) => member === requestedMembers[index]);
      });
      if (existingChat) return { id: existingChat.id, created: false };

      const current = await transaction.get(ref);
      if (current.exists) return { id, created: false };
      transaction.create(ref, {
        type: "direct",
        members,
        name: "",
        admins: [uid],
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        lastMessage: null,
      });
      return { id, created: true };
    });
    res.status(result.created ? 201 : 200).json({ id: result.id });
    return;
  }
  const ref = await db.collection("conversations").add({
    type: parsed.data.type,
    members,
    name: parsed.data.type === "group" ? parsed.data.name : "",
    photoURL: parsed.data.type === "group" ? parsed.data.photoURL ?? "" : "",
    admins: [uid],
    createdBy: uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    lastMessage: null,
  });
  res.status(201).json({ id: ref.id });
});

api.get("/conversations", async (req, res) => {
  const snapshot = await db.collection("conversations")
    .where("members", "array-contains", req.user!.uid).orderBy("updatedAt", "desc").limit(100).get();
  const conversations: Array<Record<string, unknown> & { id: string }> = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }));
  conversations.sort((a, b) => {
    const time = (value: unknown) => typeof value === "object" && value !== null && "toMillis" in value
      ? Number((value as { toMillis(): number }).toMillis()) : 0;
    return time(b.updatedAt) - time(a.updatedAt);
  });
  res.json(conversations);
});

api.post("/conversations/:id/messages", async (req, res) => {
  const parsed = validBody(messageSchema, req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.message }); return; }
  const { id } = req.params;
  const conversation = await memberConversation(id, req.user!.uid);
  if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
  if (!parsed.data.text && !parsed.data.filePath) {
    res.status(400).json({ error: "A message or attachment is required." });
    return;
  }
  if (parsed.data.filePath && !parsed.data.filePath.startsWith(`uploads/${req.user!.uid}/${id}/`)) {
    res.status(400).json({ error: "Attachments must belong to this user and conversation." });
    return;
  }
  const message = {
    senderId: req.user!.uid,
    ...parsed.data,
    deliveredBy: conversation.data.members as string[],
    readBy: [req.user!.uid],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  const messageRef = conversation.ref.collection("messages").doc();
  const batch = db.batch();
  batch.set(messageRef, message);
  batch.update(conversation.ref, {
    updatedAt: FieldValue.serverTimestamp(),
    lastMessage: { messageId: messageRef.id, text: parsed.data.text || (parsed.data.type === "voice" ? "Voice message" : parsed.data.fileName || "Attachment"), senderId: req.user!.uid },
  });
  for (const member of conversation.data.members as string[]) {
    if (member === req.user!.uid) continue;
    batch.set(db.collection("notifications").doc(), {
      userId: member,
      conversationId: id,
      message: parsed.data.text || (parsed.data.type === "voice" ? "Sent a voice message" : "Sent an attachment"),
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  res.status(201).json({ id: messageRef.id });
});

api.get("/conversations/:id/messages", async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user!.uid);
  if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
  const snapshot = await conversation.ref.collection("messages")
    .orderBy("createdAt", "desc").limit(100).get();
  res.json(snapshot.docs.reverse().map((doc) => ({ id: doc.id, ...doc.data() })));
});

api.post("/conversations/:id/read", async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user!.uid);
  if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
  const unread = await conversation.ref.collection("messages")
    .where("senderId", "!=", req.user!.uid).limit(100).get();
  const batch = db.batch();
  unread.docs.forEach((doc) => batch.update(doc.ref, { readBy: FieldValue.arrayUnion(req.user!.uid) }));
  await batch.commit();
  res.json({ ok: true });
});

api.patch("/conversations/:id/messages/:messageId", async (req, res) => {
  const parsed = z.object({ text: z.string().trim().min(1).max(10000) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Message text must be between 1 and 10,000 characters." }); return; }
  const conversation = await memberConversation(req.params.id, req.user!.uid);
  if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
  const messageRef = conversation.ref.collection("messages").doc(req.params.messageId);
  const message = await messageRef.get();
  if (!message.exists || message.data()?.senderId !== req.user!.uid) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  await messageRef.update({ text: parsed.data.text, edited: true, updatedAt: FieldValue.serverTimestamp() });
  if (conversation.data.lastMessage?.messageId === req.params.messageId) {
    await conversation.ref.update({ "lastMessage.text": parsed.data.text });
  }
  res.json({ ok: true });
});

api.delete("/conversations/:id/messages/:messageId", async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user!.uid);
  if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
  const messageRef = conversation.ref.collection("messages").doc(req.params.messageId);
  const message = await messageRef.get();
  if (!message.exists || message.data()?.senderId !== req.user!.uid) {
    res.status(404).json({ error: "Message not found." });
    return;
  }
  await messageRef.delete();
  if (conversation.data.lastMessage?.messageId === req.params.messageId) {
    const latest = await conversation.ref.collection("messages").orderBy("createdAt", "desc").limit(1).get();
    const newest = latest.docs[0];
    await conversation.ref.update({
      lastMessage: newest ? {
        messageId: newest.id,
        text: newest.data().text || (newest.data().type === "voice" ? "Voice message" : newest.data().fileName || "Attachment"),
        senderId: newest.data().senderId,
      } : null,
    });
  }
  res.json({ ok: true });
});

api.post("/conversations/:id/typing", async (req, res) => {
  const parsed = z.object({ typing: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid typing status." }); return; }
  const conversation = await memberConversation(req.params.id, req.user!.uid);
  if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
  await conversation.ref.update({ [`typing.${req.user!.uid}`]: parsed.data.typing ? FieldValue.serverTimestamp() : FieldValue.delete() });
  res.json({ ok: true });
});

api.post("/conversations/:id/members", async (req, res) => {
  const parsed = z.object({ uid: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "A valid user ID is required." }); return; }
  const conversation = await memberConversation(req.params.id, req.user!.uid);
  if (!conversation || conversation.data.type !== "group") { res.status(404).json({ error: "Group not found." }); return; }
  if (!(conversation.data.admins as string[] | undefined)?.includes(req.user!.uid)) {
    res.status(403).json({ error: "Only group admins can manage members." });
    return;
  }
  const memberProfile = await db.collection("publicProfiles").doc(parsed.data.uid).get();
  if (!memberProfile.exists) { res.status(404).json({ error: "User not found." }); return; }
  if ((conversation.data.members as string[]).length >= 100) { res.status(400).json({ error: "This group has reached its member limit." }); return; }
  await conversation.ref.update({ members: FieldValue.arrayUnion(parsed.data.uid) });
  res.json({ ok: true });
});

api.post("/conversations/:id/admins", async (req, res) => {
  const parsed = z.object({ uid: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "A valid user ID is required." }); return; }
  const conversation = await memberConversation(req.params.id, req.user!.uid);
  if (!conversation || conversation.data.type !== "group") { res.status(404).json({ error: "Group not found." }); return; }
  if (!(conversation.data.admins as string[] | undefined)?.includes(req.user!.uid)) {
    res.status(403).json({ error: "Only group admins can manage admin permissions." });
    return;
  }
  if (!(conversation.data.members as string[]).includes(parsed.data.uid)) {
    res.status(400).json({ error: "Group admins must be current group members." });
    return;
  }
  await conversation.ref.update({ admins: FieldValue.arrayUnion(parsed.data.uid) });
  res.json({ ok: true });
});

api.delete("/conversations/:id/admins/:uid", async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user!.uid);
  if (!conversation || conversation.data.type !== "group") { res.status(404).json({ error: "Group not found." }); return; }
  const admins = conversation.data.admins as string[] | undefined;
  if (!admins?.includes(req.user!.uid)) { res.status(403).json({ error: "Only group admins can manage admin permissions." }); return; }
  if (!admins.includes(req.params.uid)) { res.status(404).json({ error: "Group admin not found." }); return; }
  if (admins.length === 1) { res.status(400).json({ error: "A group must keep at least one admin." }); return; }
  await conversation.ref.update({ admins: FieldValue.arrayRemove(req.params.uid) });
  res.json({ ok: true });
});

api.delete("/conversations/:id/members/:uid", async (req, res) => {
  const conversation = await memberConversation(req.params.id, req.user!.uid);
  if (!conversation || conversation.data.type !== "group") { res.status(404).json({ error: "Group not found." }); return; }
  const admins = conversation.data.admins as string[] | undefined;
  if (!admins?.includes(req.user!.uid)) { res.status(403).json({ error: "Only group admins can manage members." }); return; }
  if (admins.includes(req.params.uid) && admins.length === 1) {
    res.status(400).json({ error: "Transfer admin rights before removing the only group admin." });
    return;
  }
  await conversation.ref.update({
    members: FieldValue.arrayRemove(req.params.uid),
    ...(admins.includes(req.params.uid) ? { admins: FieldValue.arrayRemove(req.params.uid) } : {}),
  });
  res.json({ ok: true });
});

api.post("/notifications/:id/read", async (req, res) => {
  const ref = db.collection("notifications").doc(req.params.id);
  const notification = await ref.get();
  if (!notification.exists || notification.data()?.userId !== req.user!.uid) {
    res.status(404).json({ error: "Notification not found." });
    return;
  }
  await ref.update({ read: true });
  res.json({ ok: true });
});

api.post("/notifications/read", async (req, res) => {
  const parsed = z.object({ conversationId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "A conversation ID is required." }); return; }
  const conversation = await memberConversation(parsed.data.conversationId, req.user!.uid);
  if (!conversation) { res.status(404).json({ error: "Conversation not found." }); return; }
  const snapshot = await db.collection("notifications")
    .where("userId", "==", req.user!.uid)
    .where("conversationId", "==", parsed.data.conversationId)
    .where("read", "==", false)
    .limit(450).get();
  const batch = db.batch();
  snapshot.docs.forEach((notification) => batch.update(notification.ref, { read: true }));
  await batch.commit();
  res.json({ ok: true });
});

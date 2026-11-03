import { Router } from "express";
import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { auth, db } from "../config/firebase.js";
import { authenticate } from "../middleware/authenticate.js";

export const api = Router();
api.use(authenticate);

const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  photoURL: z.string().url().max(2048).or(z.literal("")).optional(),
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

api.post("/profile", async (req, res) => {
  const parsed = validBody(profileSchema, req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.message }); return; }
  const uid = req.user!.uid;
  const userRef = db.collection("users").doc(uid);
  const previous = await userRef.get();
  const profileBatch = db.batch();
  profileBatch.set(userRef, {
    uid,
    email: req.user!.email ?? "",
    emailLower: (req.user!.email ?? "").toLowerCase(),
    displayName: parsed.data.displayName,
    photoURL: parsed.data.photoURL ?? "",
    online: true,
    lastSeen: FieldValue.serverTimestamp(),
    ...(previous.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
  }, { merge: true });
  profileBatch.set(db.collection("publicProfiles").doc(uid), {
    uid,
    displayName: parsed.data.displayName,
    displayNameLower: parsed.data.displayName.toLowerCase(),
    photoURL: parsed.data.photoURL ?? "",
    online: true,
    lastSeen: FieldValue.serverTimestamp(),
  }, { merge: true });
  await profileBatch.commit();
  res.json({ ok: true });
});

api.get("/users", async (req, res) => {
  const search = String(req.query.search ?? "").trim().toLowerCase().slice(0, 80);
  if (search.length < 2) { res.json([]); return; }
  const [nameMatches, emailMatches] = await Promise.all([
    db.collection("publicProfiles").orderBy("displayNameLower").startAt(search).endAt(`${search}\uf8ff`).limit(20).get(),
    db.collection("users").orderBy("emailLower").startAt(search).endAt(`${search}\uf8ff`).limit(20).get(),
  ]);
  const profiles = new Map<string, Record<string, unknown>>();
  nameMatches.docs.forEach((profile) => profiles.set(profile.id, profile.data()));
  const emailProfiles = await Promise.all(emailMatches.docs.map((account) => db.collection("publicProfiles").doc(account.id).get()));
  emailProfiles.forEach((profile, index) => {
    if (profile.exists) profiles.set(profile.id, { ...(profiles.get(profile.id) ?? {}), ...profile.data() });
    else {
      const account = emailMatches.docs[index].data();
      profiles.set(emailMatches.docs[index].id, {
        uid: emailMatches.docs[index].id,
        displayName: account.displayName,
        photoURL: account.photoURL,
      });
    }
  });
  const users = [...profiles.values()]
    .filter((profile) => profile.uid !== req.user!.uid)
    .map(({ uid, displayName, photoURL, online, lastSeen }) => ({
      uid,
      displayName,
      photoURL,
      online,
      lastSeen: lastSeen && typeof lastSeen === "object" && "toDate" in lastSeen
        ? (lastSeen as { toDate: () => Date }).toDate().toISOString()
        : null,
    }));
  res.json(users);
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
  const memberProfiles = await Promise.all(members.map((member) => db.collection("publicProfiles").doc(member).get()));
  if (memberProfiles.some((profile) => !profile.exists)) {
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
    const created = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if (current.exists) return false;
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
      return true;
    });
    res.status(created ? 201 : 200).json({ id });
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

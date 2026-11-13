const functions = require("firebase-functions/v1");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getDatabase } = require("firebase-admin/database");
const { FieldPath, FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { beforeUserSignedIn } = require("firebase-functions/v2/identity");
const { HttpsError } = require("firebase-functions/v2/https");
const { createHash } = require("node:crypto");

const app = getApps()[0] ?? initializeApp({ projectId: "gather-869c5" });
const firestore = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);
const day = 24 * 60 * 60 * 1000;

function storageBucket() {
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET?.trim();
  if (!bucketName) throw new Error("FIREBASE_STORAGE_BUCKET must match the Firebase project's Storage bucket.");
  return storage.bucket(bucketName);
}

function storedString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
}

function defaultUsername(uid) {
  return `user-${createHash("sha256").update(uid).digest("hex").slice(0, 24)}`;
}

async function syncAuthUserProfile(user) {
  const privateRef = firestore.collection("users").doc(user.uid);
  const publicRef = firestore.collection("publicProfiles").doc(user.uid);
  const [privateSnapshot, publicSnapshot] = await firestore.getAll(privateRef, publicRef);
  const privateProfile = privateSnapshot.data() ?? {};
  const publicProfile = publicSnapshot.data() ?? {};
  const email = storedString(user.email, privateProfile.email);
  const displayName = storedString(
    user.displayName,
    privateProfile.displayName,
    privateProfile.fullName,
    publicProfile.displayName,
    publicProfile.fullName,
    email.split("@")[0],
  ) || "Gather member";
  const oldUsername = storedString(privateProfile.username, publicProfile.username);
  const username = /^[a-zA-Z0-9._-]{2,32}$/.test(oldUsername) ? oldUsername : defaultUsername(user.uid);
  const photoURL = storedString(
    user.photoURL,
    privateProfile.photoURL,
    privateProfile.profilePicture,
    publicProfile.photoURL,
    publicProfile.profilePicture,
  );
  const about = storedString(privateProfile.about, publicProfile.about);
  const createdAt = privateProfile.createdAt
    ?? publicProfile.createdAt
    ?? (user.metadata?.creationTime
      ? Timestamp.fromDate(new Date(user.metadata.creationTime))
      : FieldValue.serverTimestamp());
  const accountCreatedAt = privateProfile.accountCreatedAt
    ?? (user.metadata?.creationTime
      ? Timestamp.fromDate(new Date(user.metadata.creationTime))
      : createdAt);
  const accountExpiresAt = privateProfile.accountExpiresAt
    ?? Timestamp.fromMillis(accountCreatedAt.toMillis() + 365 * day);
  const isOnline = typeof privateProfile.isOnline === "boolean"
    ? privateProfile.isOnline
    : typeof privateProfile.online === "boolean"
      ? privateProfile.online
      : typeof publicProfile.isOnline === "boolean"
        ? publicProfile.isOnline
        : typeof publicProfile.online === "boolean"
          ? publicProfile.online
          : false;
  const lastSeen = privateProfile.lastSeen ?? publicProfile.lastSeen ?? createdAt;
  const namePrefixes = [...new Set(displayName.toLowerCase().split(/\s+/).flatMap((part) =>
    Array.from({ length: Math.max(0, part.length - 1) }, (_unused, index) => part.slice(0, index + 2)),
  ))];
  const privateData = {
    uid: user.uid,
    username,
    usernameLower: username.toLowerCase(),
    fullName: displayName,
    fullNameLower: displayName.toLowerCase(),
    fullNamePrefixes: namePrefixes,
    displayName,
    displayNameLower: displayName.toLowerCase(),
    displayNamePrefixes: namePrefixes,
    email,
    emailLower: email.toLowerCase(),
    photoURL,
    profilePicture: photoURL,
    about,
    isOnline,
    online: isOnline,
    lastSeen,
    createdAt,
    accountCreatedAt,
    accountExpiresAt,
    accountLifetimeDays: privateProfile.accountLifetimeDays ?? 365,
    accountLifetimeConfigured: privateProfile.accountLifetimeConfigured ?? false,
    defaultMessageExpirationSeconds: privateProfile.defaultMessageExpirationSeconds ?? 604800,
    defaultSessionExpirationSeconds: privateProfile.defaultSessionExpirationSeconds ?? 2592000,
  };
  const publicData = {
    uid: user.uid,
    username,
    usernameLower: username.toLowerCase(),
    fullName: displayName,
    fullNameLower: displayName.toLowerCase(),
    displayName,
    displayNameLower: displayName.toLowerCase(),
    photoURL,
    profilePicture: photoURL,
    about,
    isOnline,
    online: isOnline,
    lastSeen,
    createdAt,
    ...(Object.hasOwn(publicProfile, "email") ? { email: FieldValue.delete() } : {}),
    ...(Object.hasOwn(publicProfile, "emailLower") ? { emailLower: FieldValue.delete() } : {}),
  };
  await firestore.runTransaction(async (transaction) => {
    const [currentPrivate, currentPublic] = await Promise.all([
      transaction.get(privateRef),
      transaction.get(publicRef),
    ]);
    if (!currentPrivate.exists) transaction.create(privateRef, privateData);
    else {
      const current = currentPrivate.data() ?? {};
      const updates = {};
      if (!current.accountCreatedAt) updates.accountCreatedAt = accountCreatedAt;
      if (!current.accountExpiresAt) updates.accountExpiresAt = accountExpiresAt;
      if (current.accountLifetimeDays === undefined) updates.accountLifetimeDays = 365;
      if (current.accountLifetimeConfigured === undefined) updates.accountLifetimeConfigured = false;
      if (current.defaultMessageExpirationSeconds === undefined) updates.defaultMessageExpirationSeconds = 604800;
      if (current.defaultSessionExpirationSeconds === undefined) updates.defaultSessionExpirationSeconds = 2592000;
      if (Object.keys(updates).length) transaction.set(privateRef, updates, { merge: true });
    }
    if (!currentPublic.exists) transaction.create(publicRef, publicData);
  });
}

exports.createUserProfiles = functions.auth.user().onCreate(async (user) => {
  await syncAuthUserProfile(user);
});

exports.syncUserPresence = functions.database
  .ref("/presence/{uid}/connections/{connectionId}")
  .onWrite(async (_change, context) => {
    const databaseURL = process.env.FIREBASE_DATABASE_URL?.trim()
      || "https://gather-869c5-default-rtdb.firebaseio.com";

    const { uid } = context.params;
    const realtimePresence = getDatabase(app, databaseURL).ref(`presence/${uid}`);
    const stateResult = await realtimePresence.transaction((current) => {
      if (!current) return current;
      const connections = current.connections ?? {};
      const online = Object.keys(connections).length > 0;
      const previousState = current.state ?? {};
      return {
        ...current,
        state: {
          online,
          revision: (Number(previousState.revision) || 0) + 1,
        },
      };
    });
    const state = stateResult.snapshot.child("state").val();
    if (!state || typeof state.revision !== "number" || typeof state.online !== "boolean") return;

    const markerRef = firestore.collection("internalPresenceState").doc(uid);
    const userRef = firestore.collection("users").doc(uid);
    const publicRef = firestore.collection("publicProfiles").doc(uid);
    await firestore.runTransaction(async (transaction) => {
      const markerSnapshot = await transaction.get(markerRef);
      const currentRevision = markerSnapshot.data()?.revision;
      if (typeof currentRevision === "number" && currentRevision >= state.revision) return;

      const [userSnapshot, publicSnapshot] = await Promise.all([
        transaction.get(userRef),
        transaction.get(publicRef),
      ]);
      transaction.set(markerRef, { revision: state.revision });
      const updates = {
        isOnline: state.online,
        online: state.online,
        lastSeen: FieldValue.serverTimestamp(),
      };
      if (userSnapshot.exists) transaction.set(userRef, updates, { merge: true });
      if (publicSnapshot.exists) transaction.set(publicRef, updates, { merge: true });
    });
  });

function isExpired(value, now = Date.now()) {
    return value instanceof Timestamp && value.toMillis() <= now;
}

function logCleanup(action, details) {
    console.log("Expiration cleanup", { action, ...details });
}

async function removeStoragePrefix(prefix) {
    const bucket = storageBucket();
    let pageQuery = { prefix, autoPaginate: false, maxResults: 100 };
    for (;;) {
      const [files, nextQuery] = await bucket.getFiles(pageQuery);
      await Promise.all(files.map((file) => file.delete({ ignoreNotFound: true })));
      if (!nextQuery) return;
      pageQuery = nextQuery;
    }
}

async function removeSessionFiles(ref) {
  let cursor;
  for (;;) {
    let query = ref.collection("messages")
      .select("filePath")
      .orderBy(FieldPath.documentId())
      .limit(200);
    if (cursor) query = query.startAfter(cursor);
    const page = await query.get();
    if (!page.size) return;
    await Promise.all(page.docs.map(async (message) => {
      const path = message.data().filePath;
      if (typeof path === "string" && path.startsWith("uploads/")) {
        await storageBucket().file(path).delete({ ignoreNotFound: true });
      }
    }));
    cursor = page.docs[page.docs.length - 1];
  }
}

function notificationRef(uid, key) {
    return firestore.collection("notifications").doc(`system_${key}_${uid}`);
}

async function notifyUsers(uids, key, message, type, conversationId = "") {
    const batch = firestore.batch();
    for (const uid of [...new Set(uids)]) {
      batch.set(notificationRef(uid, key), {
        userId: uid,
        conversationId,
        message,
        type,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 30 * day),
      }, { merge: true });
    }
    if (uids.length) await batch.commit();
}

async function expireSession(ref, data, now, notice = "Your chat session has expired.", noticeType = "sessionExpired") {
    const members = Array.isArray(data.members) ? data.members
      : Array.isArray(data.participants) ? data.participants : [];
    await notifyUsers(members, `${noticeType}_${ref.id}`, notice, noticeType, ref.id);
    await removeSessionFiles(ref);
    await Promise.all(members.map((uid) => removeStoragePrefix(`uploads/${uid}/${ref.id}/`)));
    await firestore.recursiveDelete(ref);
    logCleanup("session-deleted", { sessionId: ref.id, members: members.length, expiredAt: data.expiresAt?.toDate?.().toISOString(), checkedAt: new Date(now).toISOString() });
}

async function expireMessage(snapshot) {
    const message = snapshot.data();
    const sessionRef = snapshot.ref.parent.parent;
    if (!sessionRef) return;
    const sessionSnapshot = await sessionRef.get();
    if (isExpired(sessionSnapshot.data()?.expiresAt)) return;
    if (typeof message.filePath === "string" && message.filePath.startsWith("uploads/")) {
      await storageBucket().file(message.filePath).delete({ ignoreNotFound: true });
    }
    const session = sessionSnapshot.data() ?? {};
    const members = Array.isArray(session.members) ? session.members
      : Array.isArray(session.participants) ? session.participants : [];
    await notifyUsers(members, `message_expired_${sessionRef.id}_${snapshot.id}`, "Your message has expired.", "messageExpired", sessionRef.id);
    const relatedNotifications = await firestore.collection("notifications")
      .where("messagePath", "==", snapshot.ref.path).get();
    if (!relatedNotifications.empty) {
      const batch = firestore.batch();
      relatedNotifications.docs.forEach((notification) => batch.delete(notification.ref));
      await batch.commit();
    }
    await snapshot.ref.delete();
    if (session.lastMessage?.messageId === snapshot.id) {
      const latest = await snapshot.ref.parent.orderBy("createdAt", "desc").limit(100).get();
      const newest = latest.docs.find((doc) => !isExpired(doc.data().expiresAt));
      await sessionRef.update({
        lastMessage: newest ? {
          messageId: newest.id,
          text: newest.data().text || newest.data().fileName || "Attachment",
          senderId: newest.data().senderId,
        } : null,
      });
    }
    logCleanup("message-deleted", { messageId: snapshot.id, sessionId: sessionRef.id });
}

async function removeUserMessagesFromSession(ref, uid) {
    let cursor;
    for (;;) {
      let query = ref.collection("messages")
        .where("senderId", "==", uid)
        .orderBy(FieldPath.documentId())
        .limit(200);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (!page.size) break;
      for (const message of page.docs) {
        const path = message.data().filePath;
        if (typeof path === "string" && path.startsWith("uploads/")) {
          await storageBucket().file(path).delete({ ignoreNotFound: true });
        }
        const relatedNotifications = await firestore.collection("notifications")
          .where("messagePath", "==", message.ref.path).get();
        const batch = firestore.batch();
        relatedNotifications.docs.forEach((notification) => batch.delete(notification.ref));
        batch.delete(message.ref);
        await batch.commit();
      }
      cursor = page.docs[page.docs.length - 1];
    }
    const session = (await ref.get()).data() ?? {};
    if (session.lastMessage?.senderId === uid) {
      const latest = await ref.collection("messages").orderBy("createdAt", "desc").limit(100).get();
      const newest = latest.docs.find((message) => !isExpired(message.data().expiresAt));
      await ref.update({
        lastMessage: newest ? {
          messageId: newest.id,
          text: newest.data().text || newest.data().fileName || "Attachment",
          senderId: newest.data().senderId,
        } : null,
      });
    }
}

async function removeUserFromSessions(uid) {
  for (const [collectionName, memberField] of [["conversations", "members"], ["chats", "participants"]]) {
    let cursor;
    for (;;) {
      let query = firestore.collection(collectionName)
        .where(memberField, "array-contains", uid)
        .orderBy(FieldPath.documentId())
        .limit(100);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (!page.size) break;
      for (const snapshot of page.docs) {
        const data = snapshot.data();
        const members = Array.isArray(data.members) ? data.members : data.participants;
        const remaining = members.filter((member) => member !== uid);
        if (data.type === "direct" || Array.isArray(data.participants) || remaining.length === 0) {
          await expireSession(snapshot.ref, data, Date.now(), "A participant's account expired, so this chat was closed.", "sessionClosed");
        } else {
          await removeUserMessagesFromSession(snapshot.ref, uid);
          await firestore.runTransaction(async (transaction) => {
            const currentSnapshot = await transaction.get(snapshot.ref);
            if (!currentSnapshot.exists) return;
            const current = currentSnapshot.data() ?? {};
            const currentMembers = Array.isArray(current.members) ? current.members : [];
            if (!currentMembers.includes(uid)) return;
            const currentRemaining = currentMembers.filter((member) => member !== uid);
            if (!currentRemaining.length) {
              transaction.delete(snapshot.ref);
              return;
            }
            const currentAdmins = Array.isArray(current.admins)
              ? current.admins.filter((member) => member !== uid) : [];
            transaction.update(snapshot.ref, {
              members: FieldValue.arrayRemove(uid),
              admins: currentAdmins.length ? FieldValue.arrayRemove(uid) : [currentRemaining[0]],
              ...(current.createdBy === uid ? { createdBy: currentRemaining[0] } : {}),
              [`typing.${uid}`]: FieldValue.delete(),
            });
          });
        }
      }
      cursor = page.docs[page.docs.length - 1];
      if (page.size < 100) break;
    }
  }
}

async function removeAccount(uid) {
    const jobRef = firestore.collection("expirationJobs").doc(uid);
    await jobRef.set({ uid, status: "running", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    try {
      try {
        await auth.updateUser(uid, { disabled: true });
      } catch (error) {
        if (error.code !== "auth/user-not-found") throw error;
      }

      await removeUserFromSessions(uid);

      await removeStoragePrefix(`uploads/${uid}/`);
      let notificationCursor;
      for (;;) {
        let query = firestore.collection("notifications")
          .where("userId", "==", uid)
          .orderBy(FieldPath.documentId())
          .limit(400);
        if (notificationCursor) query = query.startAfter(notificationCursor);
        const notifications = await query.get();
        if (!notifications.size) break;
        const batch = firestore.batch();
        notifications.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        notificationCursor = notifications.docs[notifications.docs.length - 1];
        if (notifications.size < 400) break;
      }
      const databaseURL = process.env.FIREBASE_DATABASE_URL?.trim()
        || "https://gather-869c5-default-rtdb.firebaseio.com";
      await getDatabase(app, databaseURL).ref(`presence/${uid}`).remove();
      await Promise.all([
        firestore.recursiveDelete(firestore.collection("users").doc(uid)),
        firestore.recursiveDelete(firestore.collection("publicProfiles").doc(uid)),
        firestore.collection("internalPresenceState").doc(uid).delete(),
      ]);
      try {
        await auth.deleteUser(uid);
      } catch (error) {
        if (error.code !== "auth/user-not-found") throw error;
      }
      await jobRef.delete();
      logCleanup("account-deleted", { uid });
    } catch (error) {
      await jobRef.set({
        status: "retry",
        updatedAt: FieldValue.serverTimestamp(),
        lastError: error instanceof Error ? error.message : String(error),
      }, { merge: true });
      console.error("Expiration cleanup failed; it will be retried.", { uid, error });
      throw error;
    }
}

exports.blockExpiredAccountSignIn = beforeUserSignedIn(async (event) => {
    const account = await firestore.collection("users").doc(event.data.uid).get();
    const expiresAt = account.data()?.accountExpiresAt;
    if (isExpired(expiresAt)) throw new HttpsError("permission-denied", "This Gather account has expired.");
});

exports.runExpirationCleanup = functions.runWith({ timeoutSeconds: 540, memory: "1GB" })
  .pubsub.schedule("every 1 minutes").onRun(async () => {
    const now = Date.now();
    const nowTimestamp = Timestamp.fromMillis(now);
    const expiredMessages = await firestore.collectionGroup("messages")
      .where("expiresAt", "<=", nowTimestamp).limit(200).get();
    for (const message of expiredMessages.docs) {
      try {
        await expireMessage(message);
      } catch (error) {
        console.error("Message expiration failed; it will be retried.", { messageId: message.id, error });
      }
    }

    for (const collectionName of ["conversations", "chats"]) {
      const expiredSessions = await firestore.collection(collectionName)
        .where("expiresAt", "<=", nowTimestamp).limit(100).get();
      for (const session of expiredSessions.docs) {
        try {
          await expireSession(session.ref, session.data(), now);
        } catch (error) {
          console.error("Session expiration failed; it will be retried.", { sessionId: session.id, error });
        }
      }
    }

    const expiredAccounts = await firestore.collection("users")
      .where("accountExpiresAt", "<=", nowTimestamp).limit(100).get();
    for (const account of expiredAccounts.docs) {
      try {
        await removeAccount(account.id);
      } catch {
        // removeAccount logs and persists retry state; continue processing other accounts.
      }
    }
    const retryJobs = await firestore.collection("expirationJobs").where("status", "==", "retry").limit(100).get();
    for (const job of retryJobs.docs) {
      try {
        await removeAccount(job.id);
      } catch {
        // The job remains available for the next scheduled run.
      }
    }

    const expiringAccounts = await firestore.collection("users")
      .where("accountExpiresAt", ">", nowTimestamp)
      .where("accountExpiresAt", "<=", Timestamp.fromMillis(now + 7 * day))
      .limit(200).get();
    const noticeBatch = firestore.batch();
    let noticeCount = 0;
    for (const account of expiringAccounts.docs) {
      const data = account.data();
      if (isExpired(data.accountExpiresAt, now) || data.accountExpirationNoticeAt) continue;
      noticeBatch.set(notificationRef(account.id, "account_expiring"), {
        userId: account.id,
        conversationId: "",
        message: "Your account expires soon.",
        type: "accountExpiring",
        read: false,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt: Timestamp.fromMillis(Date.now() + 30 * day),
      }, { merge: true });
      noticeBatch.update(account.ref, { accountExpirationNoticeAt: FieldValue.serverTimestamp() });
      noticeCount += 1;
    }
    if (noticeCount) await noticeBatch.commit();
    return null;
});

async function backfillLegacyCollection(collectionName, markerId, initialize, needsInitialization = (data) => !data.expiresAt) {
    const markerRef = firestore.collection("expirationControl").doc(markerId);
    const marker = (await markerRef.get()).data() ?? {};
    if (marker.done) return;
    let query = firestore.collection(collectionName).orderBy(FieldPath.documentId()).limit(200);
    if (typeof marker.cursor === "string") query = query.startAfter(marker.cursor);
    const page = await query.get();
    if (!page.size) {
      await markerRef.set({ done: true, cursor: FieldValue.delete() }, { merge: true });
      return;
    }
    const now = Timestamp.now();
    const batch = firestore.batch();
    for (const snapshot of page.docs) {
      const data = snapshot.data();
      if (needsInitialization(data)) batch.set(snapshot.ref, initialize(data, now), { merge: true });
    }
    batch.set(markerRef, {
      cursor: page.docs[page.docs.length - 1].id,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await batch.commit();
}

exports.backfillExpirationFields = functions.pubsub.schedule("every 10 minutes").onRun(async () => {
    await backfillLegacyCollection("conversations", "conversations", (data, now) => ({
      expiresAt: Timestamp.fromMillis(now.toMillis() + 30 * day),
      sessionExpirationSeconds: 30 * 24 * 60 * 60,
      ...(data.createdAt ? {} : { createdAt: now }),
    }));
    await backfillLegacyCollection("chats", "chats", (data, now) => ({
      expiresAt: Timestamp.fromMillis(now.toMillis() + 30 * day),
      sessionExpirationSeconds: 30 * 24 * 60 * 60,
      ...(data.createdAt ? {} : { createdAt: now }),
    }));
    await backfillLegacyCollection("users", "users", (_data, now) => ({
      accountCreatedAt: now,
      accountExpiresAt: Timestamp.fromMillis(now.toMillis() + 365 * day),
      accountLifetimeDays: 365,
      accountLifetimeConfigured: true,
      defaultMessageExpirationSeconds: 604800,
      defaultSessionExpirationSeconds: 2592000,
    }), (data) => !data.accountExpiresAt);
    const markerRef = firestore.collection("expirationControl").doc("messages");
    const marker = (await markerRef.get()).data() ?? {};
    if (!marker.done) {
      let query = firestore.collectionGroup("messages").orderBy(FieldPath.documentId()).limit(200);
      if (typeof marker.cursor === "string") query = query.startAfter(marker.cursor);
      const page = await query.get();
      if (!page.size) {
        await markerRef.set({ done: true, cursor: FieldValue.delete() }, { merge: true });
      } else {
        const now = Timestamp.now();
        const batch = firestore.batch();
        for (const snapshot of page.docs) {
          const data = snapshot.data();
          if (!data.expiresAt) batch.set(snapshot.ref, {
            createdAt: data.createdAt ?? now,
            expiresAt: Timestamp.fromMillis(now.toMillis() + 7 * day),
            expirationSeconds: 604800,
          }, { merge: true });
        }
        batch.set(markerRef, {
          cursor: page.docs[page.docs.length - 1].ref.path,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        await batch.commit();
      }
    }
    return null;
});

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  ArrowLeft, Check, CheckCheck, FileText, ImagePlus, Mic, MoreHorizontal, Paperclip,
  Search, Send, Smile, Square, Users, X,
} from "lucide-react";
import { collection, doc, onSnapshot } from "firebase/firestore";
import { getBlob, ref, uploadBytes } from "firebase/storage";
import type { User } from "firebase/auth";
import { db, storage } from "../firebase";
import { api } from "../services/api";
import { isProfileOnline, watchMessages, watchProfiles, type Conversation, type Message, type Profile } from "../services/chat";

type Props = {
  conversation: Conversation;
  title: string;
  profile?: Profile;
  user: User;
  defaultMessageExpirationSeconds: number;
  onBack: () => void;
  onError: (message: string) => void;
};

const maxFileSize = 10 * 1024 * 1024;
const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "application/pdf", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const maxVoiceSeconds = 120;
const audioMimeTypes = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"] as const;

function initials(name?: string) {
  return (name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function formatTime(message: Message) {
  const date = message.createdAt?.toDate();
  return date ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "Sending…";
}

export default function MessagePanel({ conversation, title, profile, user, defaultMessageExpirationSeconds, onBack, onError }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [typingBy, setTypingBy] = useState<Record<string, unknown>>({});
  const [typingClock, setTypingClock] = useState(Date.now());
  const [members, setMembers] = useState<Profile[]>([]);
  const [memberIds, setMemberIds] = useState(conversation.members);
  const [admins, setAdmins] = useState(conversation.admins ?? []);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberResults, setMemberResults] = useState<Profile[]>([]);
  const [showInfo, setShowInfo] = useState(false);
  const [messageSearch, setMessageSearch] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [messageExpirationSeconds, setMessageExpirationSeconds] = useState(defaultMessageExpirationSeconds);
  const [expirationClock, setExpirationClock] = useState(Date.now());
  const [sessionExpiresAt, setSessionExpiresAt] = useState(conversation.expiresAt);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const cancelRecordingRef = useRef(false);
  const recordingStartedAt = useRef(0);
  const typingTimer = useRef<number | undefined>(undefined);
  const typingActive = useRef(false);
  const isAdmin = admins.includes(user.uid);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const seconds = Math.floor((Date.now() - recordingStartedAt.current) / 1000);
      setRecordingSeconds(seconds);
      if (seconds >= maxVoiceSeconds) stopRecording();
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  useEffect(() => {
    setLoading(true);
    return watchMessages(conversation.id, conversation.storagePath, (items) => {
      setMessages(items);
      setLoading(false);
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
      if (items.some((item) => item.senderId !== user.uid && !item.readBy?.includes(user.uid))) {
        void api(`/conversations/${conversation.id}/read`, { method: "POST" }).catch((issue: unknown) => onError(issue instanceof Error ? issue.message : "Could not mark messages as read."));
      }
    }, (issue) => { setLoading(false); onError(issue.message); });
  }, [conversation.id, conversation.storagePath, user.uid, onError]);

  useEffect(() => onSnapshot(doc(db, conversation.storagePath ?? "conversations", conversation.id), (snapshot) => {
    const data = snapshot.data();
    setSessionExpiresAt(data?.expiresAt as Conversation["expiresAt"]);
    setTypingBy((data?.typing as Record<string, unknown>) ?? {});
    if (Array.isArray(data?.members)) setMemberIds(data.members as string[]);
    if (Array.isArray(data?.admins)) setAdmins(data.admins as string[]);
  }, (issue) => onError(issue.message)), [conversation.id, conversation.storagePath, onError]);

  useEffect(() => {
    setMessageExpirationSeconds(defaultMessageExpirationSeconds);
  }, [defaultMessageExpirationSeconds]);

  useEffect(() => {
    if (!messages.some((message) => message.expiresAt) && !sessionExpiresAt) return;
    const timer = window.setInterval(() => setExpirationClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [messages, sessionExpiresAt]);

  useEffect(() => {
    if (!Object.keys(typingBy).length) return;
    const timer = window.setInterval(() => setTypingClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [typingBy]);

  useEffect(() => watchProfiles(
    memberIds.filter((uid) => uid !== user.uid),
    setMembers,
    (issue) => onError(issue.message),
  ), [memberIds.join("|"), user.uid, onError]);

  useEffect(() => {
    void Promise.all([
      api(`/conversations/${conversation.id}/read`, { method: "POST" }),
      api("/notifications/read", { method: "POST", body: JSON.stringify({ conversationId: conversation.id }) }),
    ])
      .catch((issue: unknown) => onError(issue instanceof Error ? issue.message : "Could not mark messages as read."));
    return () => {
      window.clearTimeout(typingTimer.current);
      void setTyping(false);
    };
  }, [conversation.id, onError]);

  useEffect(() => {
    if (!showInfo || memberSearch.trim().length < 2) { setMemberResults([]); return; }
    const timer = window.setTimeout(() => {
      void api<Profile[]>(`/users?search=${encodeURIComponent(memberSearch.trim())}`)
        .then((items) => setMemberResults(items.filter((item) => !memberIds.includes(item.uid))))
        .catch((issue: unknown) => onError(issue instanceof Error ? issue.message : "Could not search users."));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [showInfo, memberSearch, memberIds.join("|"), onError]);

  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const message = text.trim();
    if (!message || sending || sessionExpired) return;
    setSending(true);
    try {
      await api(`/conversations/${conversation.id}/messages`, {
        method: "POST", body: JSON.stringify({ text: message, type: "text", expirationSeconds: messageExpirationSeconds }),
      });
      setText("");
      void setTyping(false);
    } catch (issue) {
      onError(issue instanceof Error ? issue.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  async function sendFile(file?: File) {
    if (!file) return;
    if (sessionExpired) { onError("This chat session has expired."); return; }
    if (!allowedTypes.has(file.type)) { onError("Choose an image, PDF, or Word document."); return; }
    if (file.size > maxFileSize) { onError("Attachments must be 10 MB or smaller."); return; }
    setSending(true);
    try {
      const messageId = doc(collection(db, conversation.storagePath ?? "conversations", conversation.id, "messages")).id;
      const path = `uploads/${user.uid}/${conversation.id}/${messageId}/${file.name.replace(/[^\w.-]/g, "_")}`;
      const uploaded = await uploadBytes(ref(storage, path), file, { contentType: file.type });
      const type = file.type.startsWith("image/") ? "image" : "document";
      await api(`/conversations/${conversation.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text: "", type, filePath: uploaded.ref.fullPath, fileName: file.name, messageId, expirationSeconds: messageExpirationSeconds }),
      });
    } catch (issue) {
      onError(issue instanceof Error ? issue.message : "The attachment could not be uploaded.");
    } finally {
      setSending(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function sendVoice(blob: Blob, mimeType: string, durationSeconds: number) {
    if (sessionExpired) { onError("This chat session has expired."); return; }
    if (blob.size > maxFileSize) {
      onError("Voice messages must be 10 MB or smaller. Try recording a shorter message.");
      return;
    }
    setSending(true);
    try {
      const extension = mimeType === "audio/mp4" ? "m4a" : mimeType === "audio/ogg" ? "ogg" : "webm";
      const fileName = `voice-${Date.now()}.${extension}`;
      const messageId = doc(collection(db, conversation.storagePath ?? "conversations", conversation.id, "messages")).id;
      const path = `uploads/${user.uid}/${conversation.id}/${messageId}/${fileName}`;
      const uploaded = await uploadBytes(ref(storage, path), blob, { contentType: mimeType });
      await api(`/conversations/${conversation.id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          text: "",
          type: "voice",
          filePath: uploaded.ref.fullPath,
          fileName,
          messageId,
          mimeType,
          durationSeconds: Math.max(1, Math.min(maxVoiceSeconds, durationSeconds)),
          expirationSeconds: messageExpirationSeconds,
        }),
      });
    } catch (issue) {
      onError(issue instanceof Error ? issue.message : "The voice message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      onError("Voice recording isn’t supported by this browser. Try a current version of Chrome, Edge, or Firefox.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const mimeType = audioMimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      audioChunksRef.current = [];
      cancelRecordingRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const duration = Math.max(1, Math.ceil((Date.now() - recordingStartedAt.current) / 1000));
        const voiceBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || mimeType || "audio/webm" });
        const shouldSend = !cancelRecordingRef.current;
        audioChunksRef.current = [];
        mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        recorderRef.current = null;
        setRecording(false);
        setRecordingSeconds(0);
        if (shouldSend && voiceBlob.size) {
          const actualMime = voiceBlob.type.split(";")[0];
          if (actualMime === "audio/webm" || actualMime === "audio/mp4" || actualMime === "audio/ogg") {
            void sendVoice(voiceBlob, actualMime, duration);
          } else {
            onError(`This browser recorded an unsupported audio type (${actualMime || "unknown"}). Try Chrome, Edge, or Firefox.`);
          }
        }
      };
      recordingStartedAt.current = Date.now();
      recorder.start(500);
      setRecordingSeconds(0);
      setRecording(true);
    } catch (issue) {
      onError(issue instanceof Error && issue.name === "NotAllowedError"
        ? "Allow microphone access in your browser settings, then try recording again."
        : issue instanceof Error ? issue.message : "The microphone could not be started.");
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }

  function stopRecording(cancel = false) {
    cancelRecordingRef.current = cancel;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      setRecording(false);
      setRecordingSeconds(0);
    }
  }

  async function setTyping(value: boolean) {
    if (typingActive.current === value) return;
    typingActive.current = value;
    try {
      await api(`/conversations/${conversation.id}/typing`, { method: "POST", body: JSON.stringify({ typing: value }) });
    } catch (issue) {
      typingActive.current = !value;
      onError(issue instanceof Error ? issue.message : "Typing status could not be updated.");
    }
  }

  function updateDraft(value: string) {
    setText(value);
    void setTyping(Boolean(value.trim()));
    window.clearTimeout(typingTimer.current);
    if (value.trim()) typingTimer.current = window.setTimeout(() => { void setTyping(false); }, 1800);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  async function editMessage(messageId: string) {
    if (!editText.trim()) return;
    try {
      await api(`/conversations/${conversation.id}/messages/${messageId}`, {
        method: "PATCH", body: JSON.stringify({ text: editText.trim() }),
      });
      setEditing(null);
    } catch (issue) { onError(issue instanceof Error ? issue.message : "Message could not be edited."); }
  }

  async function deleteMessage(messageId: string) {
    if (!window.confirm("Delete this message? This cannot be undone.")) return;
    try {
      await api(`/conversations/${conversation.id}/messages/${messageId}`, { method: "DELETE" });
    } catch (issue) { onError(issue instanceof Error ? issue.message : "Message could not be deleted."); }
  }

  async function manageMember(uid: string, remove: boolean) {
    try {
      await api(`/conversations/${conversation.id}/members${remove ? `/${encodeURIComponent(uid)}` : ""}`, {
        method: remove ? "DELETE" : "POST",
        ...(remove ? {} : { body: JSON.stringify({ uid }) }),
      });
      if (!remove) { setMemberSearch(""); setMemberResults([]); }
    } catch (issue) { onError(issue instanceof Error ? issue.message : "Group membership could not be changed."); }
  }

  async function manageAdmin(uid: string, grant: boolean) {
    try {
      await api(`/conversations/${conversation.id}/admins${grant ? "" : `/${encodeURIComponent(uid)}`}`, {
        method: grant ? "POST" : "DELETE",
        ...(grant ? { body: JSON.stringify({ uid }) } : {}),
      });
    } catch (issue) { onError(issue instanceof Error ? issue.message : "Group admin permissions could not be changed."); }
  }

  const visibleMessages = messages.filter((message) =>
    !message.expiresAt || message.expiresAt.toDate().getTime() > expirationClock);
  const filteredMessages = messageSearch.trim()
    ? visibleMessages.filter((message) => message.text.toLowerCase().includes(messageSearch.trim().toLowerCase())
      || (message.type === "voice" && "voice message".includes(messageSearch.trim().toLowerCase())))
    : visibleMessages;
  const sessionExpired = Boolean(sessionExpiresAt && sessionExpiresAt.toDate().getTime() <= expirationClock);
  const typingNames = memberIds
    .filter((uid) => {
      const timestamp = typingBy[uid];
      if (!timestamp || typeof timestamp !== "object" || !("toMillis" in timestamp)) return false;
      return Number((timestamp as { toMillis(): number }).toMillis()) > typingClock - 4000;
    })
    .map((uid) => members.find((item) => item.uid === uid)?.displayName || "Someone");

  return <section className="chat-view">
    <header className="chat-header">
      <button className="icon-button mobile-back" onClick={onBack} aria-label="Back to conversations"><ArrowLeft size={20} /></button>
      {conversation.type === "group" ? <span className="avatar group-avatar">{conversation.photoURL ? <img src={conversation.photoURL} alt="" /> : <Users size={19} />}</span> : <span className="avatar">{profile?.photoURL ? <img src={profile.photoURL} alt="" /> : initials(title)}{isProfileOnline(profile) && <i className="online-dot" />}</span>}
      <button className="chat-title-button" onClick={() => setShowInfo(!showInfo)}><strong>{title}</strong><span>{conversation.type === "group" ? `${memberIds.length} members` : isProfileOnline(profile) ? "Online now" : "Offline"}</span></button>
      <label className="message-search"><Search size={17} /><input placeholder="Search in chat" value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} aria-label="Search messages" /></label>
      <button className="icon-button" aria-label="Conversation details" onClick={() => setShowInfo(!showInfo)}><MoreHorizontal size={20} /></button>
      {showInfo && <div className="popover conversation-info">
        <div className="info-heading"><strong>{title}</strong><button className="icon-button" onClick={() => setShowInfo(false)} aria-label="Close details"><X size={16} /></button></div>
        <span className="info-subtitle">{conversation.type === "group" ? "Group members" : "Personal conversation"}</span>
        {sessionExpiresAt && <span className="info-subtitle">Session expires {sessionExpiresAt.toDate().toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>}
        {conversation.type === "group" && members.map((member) => <div className="info-member" key={member.uid}>
          <span className="avatar avatar-small">{member.photoURL ? <img src={member.photoURL} alt="" /> : initials(member.displayName)}</span>
          <span>{member.displayName}{admins.includes(member.uid) && <small>Admin</small>}</span>
          {isAdmin && member.uid !== user.uid && <>
            <button className="text-button remove-member" onClick={() => void manageAdmin(member.uid, !admins.includes(member.uid))}>{admins.includes(member.uid) ? "Remove admin" : "Make admin"}</button>
            <button className="text-button remove-member" onClick={() => void manageMember(member.uid, true)}>Remove</button>
          </>}
        </div>)}
        {conversation.type === "group" && isAdmin && <div className="member-add">
          <label className="member-search"><Search size={15} /><input value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="Add someone…" /></label>
          {memberResults.map((item) => <button className="member-option" key={item.uid} onClick={() => void manageMember(item.uid, false)}><span className="avatar avatar-small">{item.photoURL ? <img src={item.photoURL} alt="" /> : initials(item.displayName)}</span><span>{item.displayName}</span><Check size={15} /></button>)}
        </div>}
      </div>}
    </header>
    <div className="message-canvas">
      {sessionExpired && <div className="session-expired-notice" role="status">Your chat session has expired.</div>}
      {loading ? <div className="message-state">Loading messages…</div> : visibleMessages.length === 0 ? <div className="message-empty">
        <span className="empty-icon"><MessageCircleIcon /></span><strong>Start the conversation</strong><span>Say hello to {title}.</span>
      </div> : filteredMessages.length === 0 ? <div className="message-state">No messages match “{messageSearch}”.</div> : filteredMessages.map((message, index) => {
        const own = message.senderId === user.uid;
        const previous = filteredMessages[index - 1];
        const showDate = !previous || message.createdAt?.toDate().toDateString() !== previous.createdAt?.toDate().toDateString();
        const senderName = members.find((member) => member.uid === message.senderId)?.displayName || title;
        const read = Boolean(message.readBy?.some((uid) => uid !== user.uid));
        const delivered = Boolean(message.deliveredBy?.some((uid) => uid !== user.uid));
        return <div key={message.id}>
          {showDate && <div className="date-divider"><span>{message.createdAt?.toDate().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) || "Today"}</span></div>}
          <article className={`message-row ${own ? "message-own" : ""}`}>
            {!own && <span className="avatar message-avatar">{members.find((member) => member.uid === message.senderId)?.photoURL
              ? <img src={members.find((member) => member.uid === message.senderId)?.photoURL} alt="" />
              : initials(senderName)}</span>}
            <div className="message-stack">
              {!own && conversation.type === "group" && <span className="message-sender">{senderName}</span>}
              <div className={`message-bubble ${own ? "bubble-own" : ""}`}>
                {editing === message.id ? <div className="edit-message"><textarea value={editText} onChange={(event) => setEditText(event.target.value)} autoFocus /><div><button onClick={() => setEditing(null)}>Cancel</button><button onClick={() => void editMessage(message.id)}>Save</button></div></div> : <>
                  {message.type === "image" && message.filePath && <ProtectedAttachment path={message.filePath} name={message.fileName || "Shared image"} image onError={onError} />}
                  {message.type === "document" && message.filePath && <ProtectedAttachment path={message.filePath} name={message.fileName || "Download attachment"} onError={onError} />}
                  {message.type === "voice" && message.filePath && <ProtectedAttachment path={message.filePath} name="Voice message" voice onError={onError} />}
                  {message.text && <p>{message.text}</p>}
                </>}
                <div className="message-meta"><time>{formatTime(message)}</time>{message.edited && <span>Edited</span>}{own && <span className={`read-status ${read ? "status-read" : delivered ? "status-delivered" : "status-sent"}`} title={read ? "Read" : delivered ? "Delivered" : "Sent"}>{read || delivered ? <CheckCheck size={14} /> : <Check size={14} />}</span>}</div>
              </div>
              {own && editing !== message.id && <div className="message-actions">
                {message.type === "text" && <button onClick={() => { setEditing(message.id); setEditText(message.text); }}>Edit</button>}
                <button onClick={() => void deleteMessage(message.id)}>Delete</button>
              </div>}
            </div>
          </article>
        </div>;
      })}
      {typingNames.length > 0 && <div className="typing-indicator"><span className="typing-dots"><i /><i /><i /></span>{typingNames.join(", ")} {typingNames.length > 1 ? "are" : "is"} typing</div>}
      <div ref={bottomRef} />
    </div>
    <form className="composer" onSubmit={(event) => void sendMessage(event)}>
      <label className="expiration-picker">Disappears
        <select value={messageExpirationSeconds} onChange={(event) => setMessageExpirationSeconds(Number(event.target.value))} disabled={sessionExpired || sending}>
          <option value={60}>1 min</option><option value={300}>5 min</option><option value={1800}>30 min</option>
          <option value={3600}>1 hour</option><option value={86400}>24 hours</option><option value={604800}>7 days</option>
        </select>
      </label>
      <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,.doc,.docx" hidden onChange={(event) => void sendFile(event.target.files?.[0])} />
      <button className="icon-button composer-attach" type="button" aria-label="Attach file" onClick={() => fileInputRef.current?.click()} disabled={sending || recording || sessionExpired}><Paperclip size={19} /></button>
      <button className="icon-button composer-image" type="button" aria-label="Share image" onClick={() => { if (fileInputRef.current) { fileInputRef.current.accept = "image/*"; fileInputRef.current.click(); } }} disabled={sending || recording || sessionExpired}><ImagePlus size={19} /></button>
      {recording && <div className="recording-status"><i /><span>Recording {String(Math.floor(recordingSeconds / 60)).padStart(2, "0")}:{String(recordingSeconds % 60).padStart(2, "0")}</span><button type="button" onClick={() => stopRecording(true)}>Cancel</button></div>}
      <div className="composer-input"><textarea rows={1} placeholder={sessionExpired ? "This session has expired" : recording ? "Recording a voice message…" : `Message ${title}…`} value={text} onChange={(event) => updateDraft(event.target.value)} onKeyDown={handleKeyDown} maxLength={10000} disabled={recording || sending || sessionExpired} /><button type="button" className="icon-button emoji-button" aria-label="Add emoji" onClick={() => updateDraft(`${text}🙂`)} disabled={recording || sending || sessionExpired}><Smile size={19} /></button></div>
      <button className={`icon-button voice-button ${recording ? "voice-recording" : ""}`} type="button" aria-label={recording ? "Stop and send voice message" : "Record voice message"} title={recording ? "Stop and send voice message" : "Record voice message"} onClick={() => recording ? stopRecording() : void startRecording()} disabled={sending || sessionExpired}>{recording ? <Square size={17} /> : <Mic size={19} />}</button>
      <button className="send-button" type="submit" disabled={!text.trim() || sending || recording || sessionExpired} aria-label="Send message"><Send size={18} /></button>
      <span className="composer-hint">Enter to send · Shift + Enter for a new line</span>
    </form>
  </section>;
}

function MessageCircleIcon() {
  return <Users size={22} />;
}

function ProtectedAttachment({ path, name, image = false, voice = false, onError }: { path: string; name: string; image?: boolean; voice?: boolean; onError: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState("");

  useEffect(() => {
    let active = true;
    let objectUrl = "";
    const load = () => {
      void getBlob(ref(storage, path)).then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
        else URL.revokeObjectURL(objectUrl);
      }).catch((issue: unknown) => onError(issue instanceof Error ? issue.message : "An attachment could not be loaded."));
    };
    const node = containerRef.current;
    if (!node || !("IntersectionObserver" in window)) load();
    else {
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          load();
        }
      }, { rootMargin: "160px" });
      observer.observe(node);
      return () => {
        active = false;
        observer.disconnect();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      };
    }
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, onError]);

  return <div ref={containerRef}>
    {image
      ? url ? <a className="message-image-link" href={url} target="_blank" rel="noreferrer"><img className="message-image" src={url} alt={name} /></a> : <span className="attachment-placeholder">Loading image…</span>
      : voice
        ? url ? <audio className="voice-player" controls preload="none" src={url} aria-label={name} /> : <span className="attachment-placeholder">Loading voice message…</span>
      : <a className="document-card" href={url || undefined} download={name} onClick={(event) => { if (!url) event.preventDefault(); }}><FileText size={22} /><span>{name}<small>{url ? "Download document" : "Loading document…"}</small></span></a>}
  </div>;
}

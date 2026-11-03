import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell, BellOff, Bot, Check, ChevronDown, CircleHelp, LogOut, MessageCircle, MoreHorizontal,
  Plus, Search, Settings, Users, X,
} from "lucide-react";
import { updateProfile, type User } from "firebase/auth";
import { api } from "../services/api";
import { isProfileOnline, watchConversations, watchNotifications, watchProfiles, type Conversation, type NotificationItem, type Profile } from "../services/chat";
import HelpBotPanel from "./HelpBotPanel";
import MessagePanel from "./MessagePanel";

type Props = { user: User; onLogout: () => Promise<void> };
type SearchUser = Profile;

function initials(name?: string) {
  return (name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function Avatar({ name, photoURL, online, small = false }: { name?: string; photoURL?: string; online?: boolean; small?: boolean }) {
  return <span className={`avatar ${small ? "avatar-small" : ""}`}>
    {photoURL ? <img src={photoURL} alt="" /> : initials(name)}
    {online && <i className="online-dot" />}
  </span>;
}

export default function ChatDashboard({ user, onLogout }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [active, setActive] = useState<Conversation | null>(null);
  const [helpBotOpen, setHelpBotOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<SearchUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showGroup, setShowGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupPhoto, setGroupPhoto] = useState("");
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [notifications, setNotifications] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [notificationSupported] = useState(typeof window !== "undefined" && "Notification" in window);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState(user.displayName || "");
  const [profilePhoto, setProfilePhoto] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const lastNotified = useRef<string | null>(null);

  useEffect(() => watchConversations(user, setConversations, (issue) => setError(issue.message)), [user]);
  useEffect(() => {
    let firstSnapshot = true;
    return watchNotifications(user.uid, (items: NotificationItem[]) => {
      setUnreadNotifications(items.filter((item) => !item.read).length);
      if (firstSnapshot) {
        firstSnapshot = false;
        lastNotified.current = items.find((item) => !item.read)?.id ?? null;
        return;
      }
      const newest = items.find((item) => !item.read);
      if (newest && newest.id !== lastNotified.current && notifications && "Notification" in window) {
        new Notification("New message on Gather", { body: newest.message });
      }
      if (newest) lastNotified.current = newest.id;
    }, (issue) => setError(issue.message));
  }, [user.uid, notifications]);

  const memberIds = useMemo(() => [...new Set(conversations.flatMap((item) => item.members).filter((uid) => uid !== user.uid))], [conversations, user.uid]);
  useEffect(() => watchProfiles(memberIds, (items) => {
    setProfiles(Object.fromEntries(items.map((item) => [item.uid, item])));
  }, (issue) => setError(issue.message)), [memberIds.join("|")]);

  useEffect(() => {
    if (search.trim().length < 2) { setResults([]); return; }
    const timer = window.setTimeout(() => {
      setBusy(true);
      void api<SearchUser[]>(`/users?search=${encodeURIComponent(search.trim())}`)
        .then(setResults).catch((issue: unknown) => setError(issue instanceof Error ? issue.message : "Could not search users."))
        .finally(() => setBusy(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!notificationSupported) return;
    setNotifications(Notification.permission === "granted" && localStorage.getItem("gather-notifications") !== "off");
  }, [notificationSupported]);

  async function startDirect(target: SearchUser) {
    setError("");
    try {
      const result = await api<{ id: string }>("/conversations", {
        method: "POST", body: JSON.stringify({ type: "direct", members: [target.uid] }),
      });
      const conversation = conversations.find((item) => item.id === result.id);
      setHelpBotOpen(false);
      if (conversation) setActive(conversation);
      else setActive({ id: result.id, type: "direct", members: [user.uid, target.uid] });
      setSearch("");
      setResults([]);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Could not start conversation.");
    }
  }

  async function createGroup() {
    if (!groupName.trim() || !groupMembers.length) return;
    setError("");
    try {
      const result = await api<{ id: string }>("/conversations", {
        method: "POST",
        body: JSON.stringify({ type: "group", name: groupName.trim(), photoURL: groupPhoto.trim(), members: groupMembers }),
      });
      const newConversation: Conversation = { id: result.id, type: "group", name: groupName.trim(), photoURL: groupPhoto.trim(), members: [user.uid, ...groupMembers], admins: [user.uid] };
      setHelpBotOpen(false);
      setActive(newConversation);
      setShowGroup(false);
      setGroupName("");
      setGroupPhoto("");
      setGroupMembers([]);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Could not create group.");
    }
  }

  async function toggleNotifications() {
    if (!notificationSupported) { setError("Browser notifications are not supported here."); return; }
    if (notifications) {
      localStorage.setItem("gather-notifications", "off");
      setNotifications(false);
      return;
    }
    const permission = await Notification.requestPermission();
    setNotifications(permission === "granted");
    localStorage.setItem("gather-notifications", permission === "granted" ? "on" : "off");
    if (permission !== "granted") setError("Notification permission was not granted.");
  }

  async function saveProfile() {
    setSavingProfile(true);
    setError("");
    try {
      const displayName = profileName.trim();
      await api("/profile", { method: "POST", body: JSON.stringify({ displayName, photoURL: profilePhoto.trim() }) });
      await updateProfile(user, { displayName, photoURL: profilePhoto.trim() || null });
      setProfileOpen(false);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Profile could not be updated.");
    } finally {
      setSavingProfile(false);
    }
  }

  function getTitle(conversation: Conversation) {
    if (conversation.type === "group") return conversation.name || "Untitled group";
    const other = conversation.members.find((uid) => uid !== user.uid);
    return profiles[other || ""]?.displayName || "Gather member";
  }
  function getProfile(conversation: Conversation) {
    const other = conversation.members.find((uid) => uid !== user.uid);
    return profiles[other || ""];
  }

  return <main className="app-shell">
    <aside className={`sidebar ${active || helpBotOpen ? "sidebar-hidden-mobile" : ""}`}>
      <header className="sidebar-header">
        <div className="brand-lockup"><span className="brand-mark"><MessageCircle size={21} /></span><span>gather</span></div>
        <button className="icon-button" aria-label="More options" onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={20} /></button>
        {menuOpen && <div className="popover menu-popover">
          <button onClick={() => { setProfileName(user.displayName || ""); setProfilePhoto(user.photoURL || ""); setProfileOpen(true); setMenuOpen(false); }}><Settings size={16} /> Edit profile</button>
          <button onClick={toggleNotifications}>{notifications ? <BellOff size={16} /> : <Bell size={16} />}{notifications ? "Turn off notifications" : "Enable notifications"}</button>
          <button onClick={() => void onLogout()}><LogOut size={16} /> Sign out</button>
        </div>}
      </header>
      <div className="current-user">
        <Avatar name={user.displayName || user.email || ""} />
        <div className="user-copy"><strong>{user.displayName || "Welcome to Gather"}</strong><span>Available</span></div>
        <button className="icon-button notification-button" title="Notifications" onClick={toggleNotifications}>{notifications ? <Bell size={17} /> : <BellOff size={17} />}{unreadNotifications > 0 && <i>{unreadNotifications > 9 ? "9+" : unreadNotifications}</i>}</button>
      </div>
      <div className="sidebar-section-heading"><span>Messages</span><button className="icon-button new-chat-button" title="Create a group" onClick={() => setShowGroup(true)}><Plus size={18} /></button></div>
      <div className="search-wrap"><Search size={16} /><input placeholder="Search people…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search users" /></div>
      {search.trim().length >= 2 && <div className="search-results">
        {busy && <div className="subtle-state">Searching…</div>}
        {!busy && results.length === 0 && <div className="subtle-state">No people found</div>}
        {results.map((person) => <button className="search-person" key={person.uid} onClick={() => void startDirect(person)}>
          <Avatar small name={person.displayName} photoURL={person.photoURL} online={isProfileOnline(person)} />
          <span><strong>{person.displayName}</strong><small>{isProfileOnline(person) ? "Online" : "Start a conversation"}</small></span>
          <MessageCircle size={16} />
        </button>)}
      </div>}
      <button
        className={`conversation-card help-bot-card ${helpBotOpen ? "conversation-active" : ""}`}
        onClick={() => { setActive(null); setHelpBotOpen(true); }}
        aria-current={helpBotOpen ? "page" : undefined}
      >
        <span className="help-bot-avatar"><Bot size={19} /></span>
        <span className="conversation-copy">
          <span className="conversation-line"><strong>Gather Help Bot</strong><span className="help-bot-badge">HELP</span></span>
          <span className="last-message">Ask how Gather works</span>
        </span>
      </button>
      <div className="conversation-list">
        {conversations.length === 0 ? <div className="empty-sidebar">
          <div className="empty-icon"><Users size={20} /></div><strong>Your people are one search away</strong>
          <span>Search for someone to begin a conversation.</span>
        </div> : conversations.map((conversation) => {
          const profile = getProfile(conversation);
          const isActive = active?.id === conversation.id;
          return <button key={conversation.id} className={`conversation-card ${isActive ? "conversation-active" : ""}`} onClick={() => { setHelpBotOpen(false); setActive(conversation); }}>
            {conversation.type === "group" ? <span className="avatar group-avatar">{conversation.photoURL ? <img src={conversation.photoURL} alt="" /> : <Users size={19} />}</span> : <Avatar small name={profile?.displayName} photoURL={profile?.photoURL} online={isProfileOnline(profile)} />}
            <span className="conversation-copy">
              <span className="conversation-line"><strong>{getTitle(conversation)}</strong><time>{conversation.updatedAt?.toDate().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></span>
              <span className="last-message">{conversation.lastMessage?.text || "Start a conversation"}</span>
            </span>
          </button>;
        })}
      </div>
      <footer className="sidebar-footer">
        <button className="footer-link" onClick={() => setShowGroup(true)}><Users size={17} /><span>New group</span><Plus size={16} /></button>
        <div className="footer-user">
          <Avatar small name={user.displayName || user.email || ""} />
          <span><strong>{user.displayName || "Your account"}</strong><small>{user.email}</small></span>
          <button className="icon-button" aria-label="Sign out" onClick={() => void onLogout()}><LogOut size={17} /></button>
        </div>
      </footer>
    </aside>
    <section className={`main-panel ${active || helpBotOpen ? "" : "main-panel-empty"}`}>
      {error && <div className="global-error"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss"><X size={16} /></button></div>}
      {helpBotOpen ? <HelpBotPanel key={user.uid} user={user} onBack={() => setHelpBotOpen(false)} /> : active ? <MessagePanel
        key={active.id}
        conversation={active}
        title={getTitle(active)}
        profile={getProfile(active)}
        user={user}
        onBack={() => setActive(null)}
        onError={setError}
      /> : <div className="welcome-panel">
        <span className="welcome-mark"><MessageCircle size={30} /></span>
        <span className="eyebrow">Good to have you here</span>
        <h1>Make room for<br />a good conversation.</h1>
        <p>Choose someone from your messages or search for a person to get started.</p>
        <div className="welcome-tips"><span><Check size={15} /> Private by design</span><span><Check size={15} /> Here, in real time</span></div>
      </div>}
      <button className="floating-help" title="Open Gather Help Bot" aria-label="Open Gather Help Bot" onClick={() => { setActive(null); setHelpBotOpen(true); }}><CircleHelp size={17} /></button>
    </section>
    {showGroup && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowGroup(false); }}>
      <section className="group-modal">
        <header><div><span className="eyebrow">Bring people together</span><h2>Create a group</h2></div><button className="icon-button" onClick={() => setShowGroup(false)} aria-label="Close"><X size={20} /></button></header>
        <label>Group name<input autoFocus value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="e.g. Weekend plans" maxLength={100} /></label>
        <label>Group picture URL<input type="url" value={groupPhoto} onChange={(event) => setGroupPhoto(event.target.value)} placeholder="Optional image URL" /></label>
        <label>Find members<div className="search-wrap modal-search"><Search size={16} /><input placeholder="Search people…" value={search} onChange={(event) => setSearch(event.target.value)} /></div></label>
        <div className="member-picker">
          {results.map((person) => <button className="member-option" key={person.uid} onClick={() => setGroupMembers((members) => members.includes(person.uid) ? members.filter((id) => id !== person.uid) : [...members, person.uid])}>
            <Avatar small name={person.displayName} photoURL={person.photoURL} />
            <span>{person.displayName}</span>
            {groupMembers.includes(person.uid) && <Check size={17} />}
          </button>)}
          {!results.length && <span className="subtle-state">Search for people to add to your group.</span>}
        </div>
        {groupMembers.length > 0 && <div className="selected-count">{groupMembers.length} member{groupMembers.length === 1 ? "" : "s"} selected</div>}
        <button className="primary-button full-button" disabled={!groupName.trim() || !groupMembers.length} onClick={() => void createGroup()}>Create group <ChevronDown size={16} /></button>
      </section>
    </div>}
    {profileOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setProfileOpen(false); }}>
      <section className="group-modal">
        <header><div><span className="eyebrow">Your Gather profile</span><h2>Edit profile</h2></div><button className="icon-button" onClick={() => setProfileOpen(false)} aria-label="Close"><X size={20} /></button></header>
        <label>Display name<input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={80} required /></label>
        <label>Profile picture URL<input type="url" value={profilePhoto} onChange={(event) => setProfilePhoto(event.target.value)} placeholder="https://…" /></label>
        <button className="primary-button full-button" disabled={!profileName.trim() || savingProfile} onClick={() => void saveProfile()}>{savingProfile ? "Saving…" : "Save changes"}</button>
      </section>
    </div>}
  </main>;
}

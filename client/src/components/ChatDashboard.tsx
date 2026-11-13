import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell, BellOff, Bot, Check, ChevronDown, CircleHelp, LogOut, MessageCircle, MoreHorizontal,
  Plus, Search, Settings, Users, X,
} from "lucide-react";
import { updateProfile, type User } from "firebase/auth";
import { api } from "../services/api";
import { isProfileOnline, watchConversations, watchNotifications, watchProfiles, watchPublicProfiles, type Conversation, type NotificationItem, type Profile } from "../services/chat";
import { syncUserProfile } from "../services/profile";
import HelpBotPanel from "./HelpBotPanel";
import MessagePanel from "./MessagePanel";

type Props = {
  user: User;
  onLogout: () => Promise<void>;
  presenceError?: string;
  onClearPresenceError?: () => void;
};
type SearchUser = Profile;
const dayMilliseconds = 24 * 60 * 60 * 1000;
type ExpirationSettings = {
  defaultMessageExpirationSeconds: number;
  defaultSessionExpirationSeconds: number;
  accountCreatedAt: number | null;
  accountExpiresAt: number | null;
  accountLifetimeDays: number;
};

const messageExpirationOptions = [
  [60, "1 minute"], [300, "5 minutes"], [1800, "30 minutes"],
  [3600, "1 hour"], [86400, "24 hours"], [604800, "7 days"],
] as const;
const sessionExpirationOptions = [
  [3600, "1 hour"], [86400, "24 hours"], [604800, "7 days"], [2592000, "30 days"],
] as const;
const emptyExpirationSettings: ExpirationSettings = {
  defaultMessageExpirationSeconds: 604800,
  defaultSessionExpirationSeconds: 2592000,
  accountCreatedAt: null,
  accountExpiresAt: null,
  accountLifetimeDays: 365,
};

function initials(name?: string) {
  return (name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function defaultUsername(name: string, uid: string) {
  const username = name.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
  return username.length >= 2 ? username : `user${uid.slice(0, 8).toLowerCase()}`;
}

function formatLastSeen(value: Profile["lastSeen"]) {
  const timestamp = typeof value === "string" ? Date.parse(value) : value?.toDate().getTime();
  if (!timestamp || !Number.isFinite(timestamp)) return "Not available";
  return new Date(timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function Avatar({ name, photoURL, online, small = false }: { name?: string; photoURL?: string; online?: boolean; small?: boolean }) {
  return <span className={`avatar ${small ? "avatar-small" : ""}`}>
    {photoURL ? <img src={photoURL} alt="" /> : initials(name)}
    {online && <i className="online-dot" />}
  </span>;
}

export default function ChatDashboard({ user, onLogout, presenceError, onClearPresenceError }: Props) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [profiles, setProfiles] = useState<Record<string, Profile>>({});
  const [active, setActive] = useState<Conversation | null>(null);
  const [helpBotOpen, setHelpBotOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [directory, setDirectory] = useState<SearchUser[]>([]);
  const [directoryLoaded, setDirectoryLoaded] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [error, setError] = useState("");
  const [showGroup, setShowGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupPhoto, setGroupPhoto] = useState("");
  const [groupMembers, setGroupMembers] = useState<string[]>([]);
  const [groupSessionExpirationSeconds, setGroupSessionExpirationSeconds] = useState(2592000);
  const [notifications, setNotifications] = useState(false);
  const [unreadNotifications, setUnreadNotifications] = useState(0);
  const [notificationSupported] = useState(typeof window !== "undefined" && "Notification" in window);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState(user.displayName || "");
  const [profileUsername, setProfileUsername] = useState(defaultUsername(user.displayName || user.email || "", user.uid));
  const [profilePhoto, setProfilePhoto] = useState("");
  const [profileAbout, setProfileAbout] = useState("");
  const [viewingProfile, setViewingProfile] = useState<SearchUser | null>(null);
  const [startingDirect, setStartingDirect] = useState(false);
  const [directStartError, setDirectStartError] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileNotice, setProfileNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [expirationSettings, setExpirationSettings] = useState(emptyExpirationSettings);
  const [savingSettings, setSavingSettings] = useState(false);
  const [expirationNotice, setExpirationNotice] = useState("");
  const lastNotified = useRef<string | null>(null);

  useEffect(() => watchConversations(user, setConversations, (issue) => setError(issue.message)), [user]);
  useEffect(() => {
    let active = true;
    void api<Omit<ExpirationSettings, "accountCreatedAt" | "accountExpiresAt"> & {
      accountCreatedAt: number | null;
      accountExpiresAt: number | null;
    }>("/settings").then((settings) => {
      if (active) {
        setExpirationSettings(settings);
        setGroupSessionExpirationSeconds(settings.defaultSessionExpirationSeconds);
      }
    }).catch((issue: unknown) => {
      if (active) setError(issue instanceof Error ? issue.message : "Could not load expiration settings.");
    });
    return () => { active = false; };
  }, [user.uid]);
  useEffect(() => {
    let firstSnapshot = true;
    const showExpirationNotice = (item: NotificationItem) => {
      setExpirationNotice(item.message);
      if (!item.read) {
        void api(`/notifications/${item.id}/read`, { method: "POST" })
          .catch((issue: unknown) => setError(issue instanceof Error ? issue.message : "Could not mark the expiration notice as read."));
      }
    };
    return watchNotifications(user.uid, (items: NotificationItem[]) => {
      setUnreadNotifications(items.filter((item) => !item.read).length);
      if (firstSnapshot) {
        firstSnapshot = false;
        lastNotified.current = items.find((item) => !item.read)?.id ?? null;
        const existingNotice = items.find((item) => !item.read && item.type && item.type !== "message");
        if (existingNotice) showExpirationNotice(existingNotice);
        return;
      }
      const newest = items.find((item) => !item.read);
      if (newest && newest.id !== lastNotified.current) {
        if (newest.type && newest.type !== "message") showExpirationNotice(newest);
        if (notifications && "Notification" in window) {
          new Notification(newest.type === "accountExpiring" ? "Gather account expiration" : newest.type ? "Gather expiration notice" : "New message on Gather", { body: newest.message });
        }
      }
      if (newest) lastNotified.current = newest.id;
    }, (issue) => setError(issue.message));
  }, [user.uid, notifications]);

  const memberIds = useMemo(() => [...new Set(conversations.flatMap((item) => item.members).filter((uid) => uid !== user.uid))], [conversations, user.uid]);
  const profileIds = useMemo(() => [...new Set([...memberIds, user.uid])], [memberIds, user.uid]);
  useEffect(() => watchProfiles(profileIds, (items) => {
    setProfiles(Object.fromEntries(items.map((item) => [item.uid, item])));
  }, (issue) => setError(issue.message)), [profileIds.join("|")]);

  useEffect(() => {
    setDirectoryLoaded(false);
    setSearchError("");
    return watchPublicProfiles((items) => {
      setDirectory(items);
      setDirectoryLoaded(true);
      setSearchError("");
    }, (issue) => {
      setDirectoryLoaded(true);
      setSearchError(issue.message);
    });
  }, [user.uid]);

  const results = useMemo(() => {
    const term = search.trim().replace(/^@/, "").toLowerCase();
    if (term.length < 2) return [];
    return directory.filter((profile) => {
      if (profile.uid === user.uid) return false;
      const username = profile.username?.toLowerCase() ?? "";
      const name = (profile.fullName || profile.displayName).toLowerCase();
      return username.includes(term) || name.includes(term);
    });
  }, [directory, search, user.uid]);

  useEffect(() => {
    if (!viewingProfile) return;
    const latest = results.find((profile) => profile.uid === viewingProfile.uid);
    if (latest) setViewingProfile(latest);
    else if (directoryLoaded && search.trim().length >= 2) setViewingProfile(null);
  }, [results, viewingProfile?.uid, directoryLoaded, search]);

  useEffect(() => {
    if (!notificationSupported) return;
    setNotifications(Notification.permission === "granted" && localStorage.getItem("gather-notifications") !== "off");
  }, [notificationSupported]);

  async function startDirect(target: SearchUser) {
    setError("");
    setDirectStartError("");
    setStartingDirect(true);
    try {
      const result = await api<{ id: string; storagePath: "chats" | "conversations" }>("/conversations", {
        method: "POST", body: JSON.stringify({
          type: "direct",
          members: [target.uid],
          sessionExpirationSeconds: expirationSettings.defaultSessionExpirationSeconds,
        }),
      });
      setProfiles((current) => ({ ...current, [target.uid]: target }));
      const conversation = conversations.find((item) => item.id === result.id);
      setHelpBotOpen(false);
      if (conversation) setActive(conversation);
      else setActive({ id: result.id, type: "direct", members: [user.uid, target.uid], storagePath: result.storagePath });
      setSearch("");
      setViewingProfile(null);
    } catch (issue) {
      const message = issue instanceof Error ? issue.message : "Could not start conversation.";
      setDirectStartError(message);
      setError(message);
    } finally {
      setStartingDirect(false);
    }
  }

  async function createGroup() {
    if (!groupName.trim() || !groupMembers.length) return;
    setError("");
    try {
      const result = await api<{ id: string }>("/conversations", {
        method: "POST",
        body: JSON.stringify({
          type: "group",
          name: groupName.trim(),
          photoURL: groupPhoto.trim(),
          members: groupMembers,
          sessionExpirationSeconds: groupSessionExpirationSeconds,
        }),
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
    setProfileNotice("");
    try {
      const displayName = profileName.trim();
      const username = profileUsername.trim();
      await updateProfile(user, { displayName, photoURL: profilePhoto.trim() || null });
      await syncUserProfile(user, {
        fullName: displayName,
        username,
        profilePicture: profilePhoto.trim(),
        about: profileAbout.trim(),
      });
      setProfileNotice("Profile updated. Search People will refresh automatically.");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Profile could not be updated.");
    } finally {
      setSavingProfile(false);
    }
  }

  async function saveExpirationSettings() {
    setSavingSettings(true);
    setError("");
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify({
          defaultMessageExpirationSeconds: expirationSettings.defaultMessageExpirationSeconds,
          defaultSessionExpirationSeconds: expirationSettings.defaultSessionExpirationSeconds,
        }),
      });
      setSettingsOpen(false);
      setProfileNotice("Expiration settings saved.");
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Expiration settings could not be saved.");
    } finally {
      setSavingSettings(false);
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
          <button onClick={() => {
            setProfileName(profiles[user.uid]?.displayName || user.displayName || "");
            setProfileUsername(profiles[user.uid]?.username || defaultUsername(user.displayName || user.email || "", user.uid));
            setProfilePhoto(profiles[user.uid]?.photoURL || user.photoURL || "");
            setProfileAbout(profiles[user.uid]?.about || "");
            setProfileOpen(true);
            setMenuOpen(false);
          }}><Settings size={16} /> Edit profile</button>
          <button onClick={() => { setSettingsOpen(true); setMenuOpen(false); }}><Settings size={16} /> Settings</button>
          <button onClick={toggleNotifications}>{notifications ? <BellOff size={16} /> : <Bell size={16} />}{notifications ? "Turn off notifications" : "Enable notifications"}</button>
          <button onClick={() => void onLogout()}><LogOut size={16} /> Sign out</button>
        </div>}
      </header>
      <div className="current-user">
        <Avatar name={user.displayName || user.email || ""} />
        <div className="user-copy"><strong>{user.displayName || "Welcome to Gather"}</strong><span>{isProfileOnline(profiles[user.uid]) ? "Online" : "Offline"}</span></div>
        <button className="icon-button notification-button" title="Notifications" onClick={toggleNotifications}>{notifications ? <Bell size={17} /> : <BellOff size={17} />}{unreadNotifications > 0 && <i>{unreadNotifications > 9 ? "9+" : unreadNotifications}</i>}</button>
      </div>
      <div className="sidebar-section-heading"><span>Messages</span><button className="icon-button new-chat-button" title="Create a group" onClick={() => setShowGroup(true)}><Plus size={18} /></button></div>
      <div className="search-wrap"><Search size={16} /><input placeholder="Search people…" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search users" /></div>
      {search.trim().length >= 2 && <div className="search-results" aria-live="polite">
        {!directoryLoaded && <div className="subtle-state">Loading registered accounts…</div>}
        {directoryLoaded && searchError && <div className="subtle-state search-error">{searchError}</div>}
        {directoryLoaded && !searchError && results.length === 0 && <div className="subtle-state">No registered users found</div>}
        {results.map((person) => <button className="search-person" key={person.uid} onClick={() => setViewingProfile(person)}>
          <Avatar small name={person.displayName} photoURL={person.photoURL} online={isProfileOnline(person)} />
          <span><strong>{person.displayName}</strong><small>@{person.username || defaultUsername(person.displayName, person.uid)} · {isProfileOnline(person) ? "Online" : "Offline"}</small></span>
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
      {presenceError && <div className="global-error" role="alert"><span>{presenceError}</span><button onClick={onClearPresenceError} aria-label="Dismiss"><X size={16} /></button></div>}
      {(expirationNotice || profileNotice) && <div className="global-success" role="status">
        <span>{expirationNotice || profileNotice}</span>
        <button onClick={() => { setExpirationNotice(""); setProfileNotice(""); }} aria-label="Dismiss"><X size={16} /></button>
      </div>}
      {helpBotOpen ? <HelpBotPanel key={user.uid} user={user} onBack={() => setHelpBotOpen(false)} /> : active ? <MessagePanel
        key={active.id}
        conversation={active}
        title={getTitle(active)}
        profile={getProfile(active)}
        user={user}
        defaultMessageExpirationSeconds={expirationSettings.defaultMessageExpirationSeconds}
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
        <label>Session expiration<select value={groupSessionExpirationSeconds} onChange={(event) => setGroupSessionExpirationSeconds(Number(event.target.value))}>
          {sessionExpirationOptions.map(([seconds, label]) => <option key={seconds} value={seconds}>{label}</option>)}
        </select></label>
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
    {settingsOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
      <section className="group-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header><div><span className="eyebrow">Privacy and retention</span><h2 id="settings-title">Settings</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close"><X size={20} /></button></header>
        <label>Default disappearing message duration<select value={expirationSettings.defaultMessageExpirationSeconds} onChange={(event) => setExpirationSettings((settings) => ({ ...settings, defaultMessageExpirationSeconds: Number(event.target.value) }))}>
          {messageExpirationOptions.map(([seconds, label]) => <option key={seconds} value={seconds}>{label}</option>)}
        </select></label>
        <label>Default session lifetime<select value={expirationSettings.defaultSessionExpirationSeconds} onChange={(event) => setExpirationSettings((settings) => ({ ...settings, defaultSessionExpirationSeconds: Number(event.target.value) }))}>
          {sessionExpirationOptions.map(([seconds, label]) => <option key={seconds} value={seconds}>{label}</option>)}
        </select></label>
        <div className="account-expiration-summary">
          <strong>Account lifetime</strong>
          <span>{expirationSettings.accountExpiresAt
            ? `Expires ${new Date(expirationSettings.accountExpiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
            : "Expiration date is being set up."}</span>
          {expirationSettings.accountExpiresAt && <small>{Math.max(0, Math.ceil((expirationSettings.accountExpiresAt - Date.now()) / dayMilliseconds))} days remaining · {expirationSettings.accountLifetimeDays}-day lifetime</small>}
        </div>
        <button className="primary-button full-button" disabled={savingSettings} onClick={() => void saveExpirationSettings()}>{savingSettings ? "Saving…" : "Save settings"}</button>
      </section>
    </div>}
    {profileOpen && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setProfileOpen(false); }}>
      <section className="group-modal profile-edit-modal">
        <header><div><span className="eyebrow">Your Gather profile</span><h2>Edit profile</h2></div><button className="icon-button" onClick={() => setProfileOpen(false)} aria-label="Close"><X size={20} /></button></header>
        <label>Display name<input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={80} required /></label>
        <label>Username<input value={profileUsername} onChange={(event) => setProfileUsername(event.target.value)} minLength={2} maxLength={32} pattern="[A-Za-z0-9._-]{2,32}" autoCapitalize="none" autoCorrect="off" required /></label>
        <label>About<textarea value={profileAbout} onChange={(event) => setProfileAbout(event.target.value)} maxLength={300} placeholder="A little about you" /></label>
        <label>Profile picture URL<input type="url" value={profilePhoto} onChange={(event) => setProfilePhoto(event.target.value)} placeholder="https://…" /></label>
        <button className="primary-button full-button" disabled={!profileName.trim() || !/^[a-zA-Z0-9._-]{2,32}$/.test(profileUsername.trim()) || savingProfile} onClick={() => void saveProfile()}>{savingProfile ? "Saving…" : "Save changes"}</button>
        {profileNotice && <p className="success-message" role="status">{profileNotice}</p>}
      </section>
    </div>}
    {viewingProfile && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewingProfile(null); }}>
      <section className="group-modal user-profile-modal" role="dialog" aria-modal="true" aria-labelledby="user-profile-title">
        <header><div><span className="eyebrow">Gather member</span><button className="icon-button" onClick={() => setViewingProfile(null)} aria-label="Close profile"><X size={20} /></button></div></header>
        <div className="profile-hero">
          <Avatar name={viewingProfile.displayName} photoURL={viewingProfile.photoURL} online={isProfileOnline(viewingProfile)} />
          <h2 id="user-profile-title">{viewingProfile.displayName}</h2>
          <span className="profile-username">@{viewingProfile.username || defaultUsername(viewingProfile.displayName, viewingProfile.uid)}</span>
          <span className={`profile-presence ${isProfileOnline(viewingProfile) ? "is-online" : ""}`}>
            <i />{isProfileOnline(viewingProfile) ? "Online" : "Offline"}
          </span>
        </div>
        <div className="profile-details">
          <div><span>Last seen</span><strong>{isProfileOnline(viewingProfile) ? "Now" : formatLastSeen(viewingProfile.lastSeen)}</strong></div>
          <div className="profile-about"><span>About</span><p>{viewingProfile.about?.trim() || "This person hasn't added an about section yet."}</p></div>
        </div>
        <button className="primary-button full-button chat-now-button" disabled={startingDirect} onClick={() => void startDirect(viewingProfile)}>
          <MessageCircle size={17} />{startingDirect ? "Opening chat…" : "Chat Now"}
        </button>
        {directStartError && <p className="chat-start-error" role="alert">{directStartError}</p>}
      </section>
    </div>}
  </main>;
}

import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged, reload, signOut, type User } from "firebase/auth";
import { auth } from "./firebase";
import { api, getApiBaseUrl } from "./services/api";
import { syncUserProfile } from "./services/profile";
import { startPresence } from "./services/presence";
import AuthScreen from "./components/AuthScreen";
import ChatDashboard from "./components/ChatDashboard";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authVersion, setAuthVersion] = useState(0);
  const [profileReady, setProfileReady] = useState(false);
  const [profileError, setProfileError] = useState("");
  const [presenceError, setPresenceError] = useState("");
  const [profileRetry, setProfileRetry] = useState(0);
  const signingOut = useRef(false);
  const stopPresence = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => onAuthStateChanged(auth, (nextUser) => {
    if (nextUser) signingOut.current = false;
    setUser(nextUser);
    setLoading(false);
  }), []);

  async function refreshVerification() {
    if (!auth.currentUser) return;
    await reload(auth.currentUser);
    setAuthVersion((version) => version + 1);
  }

  useEffect(() => {
    if (!user) {
      setProfileReady(false);
      setPresenceError("");
      return;
    }

    let active = true;
    setProfileReady(false);
    setProfileError("");
    setPresenceError("");
    void (async () => {
      try {
        await syncUserProfile(user);
        const accountLifetime = localStorage.getItem(`gather-account-lifetime-${user.uid}`);
        if (accountLifetime) {
          const accountLifetimeDays = Number(accountLifetime);
          if (![7, 30, 90, 180, 365].includes(accountLifetimeDays)) {
            throw new Error("The selected account lifetime is invalid. Sign out and contact support.");
          }
          await api("/register-profile", {
            method: "POST",
            body: JSON.stringify({ displayName: user.displayName || user.email?.split("@")[0] || "Gather member", accountLifetimeDays }),
          });
          localStorage.removeItem(`gather-account-lifetime-${user.uid}`);
        }
        if (!active) return;
        setProfileReady(true);
        if (user.emailVerified) {
          try {
            stopPresence.current = startPresence(user.uid, (error) => {
              if (active) setPresenceError(error.message);
            });
          } catch (error) {
            setPresenceError(error instanceof Error ? error.message : "Could not start realtime presence.");
          }
        }
      } catch (error) {
        if (active) setProfileError(error instanceof Error ? error.message : "Could not synchronize your Firestore profile.");
      }
    })();

    return () => {
      active = false;
      const stop = stopPresence.current;
      stopPresence.current = null;
      if (stop) void stop().catch((error: unknown) => console.error("Could not stop realtime presence:", error));
    };
  }, [user, authVersion, profileRetry]);

  async function logout() {
    signingOut.current = true;
    try {
      if (auth.currentUser) {
        const stop = stopPresence.current;
        stopPresence.current = null;
        if (stop) await stop();
        const token = await auth.currentUser.getIdToken();
        const response = await fetch(`${getApiBaseUrl()}/api/session/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
        if (!response.ok) throw new Error(`Could not invalidate server session (${response.status}).`);
      }
    } catch (error) {
      console.error("Server logout failed:", error);
    } finally {
      await signOut(auth);
    }
  }

  if (loading) return <div className="loading-screen"><span className="brand-mark">g</span><span>Gather</span></div>;
  if (!user) return <AuthScreen />;
  if (!user.emailVerified) return <AuthScreen
    verificationUser={user}
    onVerifiedSession={refreshVerification}
    profileSyncError={profileError}
    onRetryProfileSync={() => setProfileRetry((attempt) => attempt + 1)}
  />;
  if (!profileReady) return <div className={`loading-screen${profileError ? " profile-sync-error" : ""}`}>
    {profileError
      ? <><p role="alert">Could not synchronize your Firestore profile: {profileError}</p><div className="profile-sync-actions"><button className="primary-button" onClick={() => setProfileRetry((attempt) => attempt + 1)}>Retry</button><button className="text-button" onClick={() => void logout()}>Sign out</button></div></>
      : <><span className="brand-mark">g</span><span>Setting up your profile…</span></>}
  </div>;
  return <ChatDashboard
    user={user}
    onLogout={logout}
    presenceError={presenceError}
    onClearPresenceError={() => setPresenceError("")}
  />;
}

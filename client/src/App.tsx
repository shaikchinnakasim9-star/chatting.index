import { useEffect, useRef, useState } from "react";
import { onAuthStateChanged, reload, signOut, type User } from "firebase/auth";
import { auth } from "./firebase";
import { getApiBaseUrl } from "./services/api";
import AuthScreen from "./components/AuthScreen";
import ChatDashboard from "./components/ChatDashboard";

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [authVersion, setAuthVersion] = useState(0);
  const signingOut = useRef(false);

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
    if (!user || !user.emailVerified) return;
    const base = getApiBaseUrl();
    let active = true;
    const sendPresence = async (online: boolean) => {
      if (!active) return;
      const token = await user.getIdToken();
      const response = await fetch(`${base}/api/presence`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ online }),
      });
      if (!response.ok) throw new Error(`Presence update failed (${response.status}).`);
    };
    const updatePresence = () => {
      void sendPresence(document.visibilityState === "visible")
        .catch((error: unknown) => console.error("Presence update failed:", error));
    };

    void (async () => {
      const token = await user.getIdToken();
      const response = await fetch(`${base}/api/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          displayName: user.displayName || user.email?.split("@")[0] || "Gather member",
          photoURL: user.photoURL || "",
        }),
      });
      if (!response.ok) throw new Error(`Profile setup failed (${response.status}).`);
      await sendPresence(true);
    })().catch((error: unknown) => console.error("Account setup failed:", error));

    document.addEventListener("visibilitychange", updatePresence);
    const heartbeat = window.setInterval(updatePresence, 60_000);
    return () => {
      active = false;
      window.clearInterval(heartbeat);
      document.removeEventListener("visibilitychange", updatePresence);
      if (!signingOut.current) {
        void user.getIdToken().then((token) => fetch(`${base}/api/presence`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ online: false }),
          keepalive: true,
        })).catch((error: unknown) => console.error("Could not set offline presence:", error));
      }
    };
  }, [user, authVersion]);

  async function logout() {
    signingOut.current = true;
    try {
      if (auth.currentUser) {
        const token = await auth.currentUser.getIdToken();
        const base = getApiBaseUrl();
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
        const presence = await fetch(`${base}/api/presence`, {
          method: "POST",
          headers,
          body: JSON.stringify({ online: false }),
        });
        if (!presence.ok) throw new Error(`Could not update offline presence (${presence.status}).`);
        const session = await fetch(`${base}/api/session/logout`, { method: "POST", headers });
        if (!session.ok) throw new Error(`Could not invalidate server session (${session.status}).`);
      }
    } catch (error) {
      console.error("Server logout failed:", error);
    } finally {
      await signOut(auth);
    }
  }

  if (loading) return <div className="loading-screen"><span className="brand-mark">g</span><span>Gather</span></div>;
  if (!user) return <AuthScreen />;
  if (!user.emailVerified) return <AuthScreen verificationUser={user} onVerifiedSession={refreshVerification} />;
  return <ChatDashboard user={user} onLogout={logout} />;
}

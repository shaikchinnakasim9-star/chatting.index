import { useEffect, useState, type FormEvent } from "react";
import { createUserWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, signInWithEmailAndPassword, updateProfile, type User } from "firebase/auth";
import { ArrowRight, CheckCircle2, MessageCircle, ShieldCheck } from "lucide-react";
import { auth } from "../firebase";

type Props = {
  verificationUser?: User | null;
  onVerifiedSession?: () => void;
};

const retryKey = (uid: string) => `gather-verification-retry-${uid}`;
const pendingErrorKey = (uid: string) => `gather-verification-error-${uid}`;

function authErrorMessage(issue: unknown) {
  const code = typeof issue === "object" && issue !== null && "code" in issue
    ? String(issue.code)
    : "";
  if (code === "auth/too-many-requests") {
    return "Firebase has temporarily limited verification emails. Wait before requesting another one; repeated requests can extend the delay.";
  }
  if (code === "auth/invalid-email") return "This email address looks invalid. Check the address and try again.";
  if (code === "auth/network-request-failed") return "The email request could not reach Firebase. Check your internet connection and try again.";
  return issue instanceof Error
    ? issue.message.replace(/^Firebase:\s*/i, "").replace(/\s*\(auth\/[^)]+\)\.?$/, "")
    : "The verification email could not be sent.";
}

export default function AuthScreen({ verificationUser, onVerifiedSession }: Props) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [authSetupRequired, setAuthSetupRequired] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [resendSeconds, setResendSeconds] = useState(() => {
    if (!verificationUser) return 0;
    return Math.max(0, Math.ceil((Number(localStorage.getItem(retryKey(verificationUser.uid)) || 0) - Date.now()) / 1000));
  });

  useEffect(() => {
    if (!verificationUser) return;
    const updateCountdown = () => {
      const retryAt = Number(localStorage.getItem(retryKey(verificationUser.uid)) || 0);
      setResendSeconds(Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [verificationUser]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setAuthSetupRequired(false);
    setNotice("");
    setBusy(true);
    try {
      if (mode === "forgot") {
        await sendPasswordResetEmail(auth, email.trim());
        setNotice("If an account exists for this address, a password reset email is on its way.");
      } else if (mode === "register") {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        await updateProfile(credential.user, { displayName: name.trim() });
        await sendEmailVerification(credential.user);
        localStorage.setItem(retryKey(credential.user.uid), String(Date.now() + 60_000));
        setNotice("Your account is ready. Verify your email using the link we just sent.");
      } else {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      }
    } catch (issue) {
      const code = typeof issue === "object" && issue !== null && "code" in issue
        ? String(issue.code)
        : "";
      if (mode === "register" && auth.currentUser && !auth.currentUser.emailVerified) {
        localStorage.setItem(pendingErrorKey(auth.currentUser.uid), authErrorMessage(issue));
        if (code === "auth/too-many-requests") {
          localStorage.setItem(retryKey(auth.currentUser.uid), String(Date.now() + 5 * 60_000));
        }
      }
      if (code === "auth/configuration-not-found" || code === "auth/operation-not-allowed") {
        setAuthSetupRequired(true);
        setError("Email/password sign-in isn’t enabled for this Firebase project yet.");
      } else if (code === "auth/too-many-requests") {
        setError("Firebase temporarily blocked sign-in attempts after too many requests. Pause before trying again; this lock can take a while to clear. If you already registered, use “Forgot password?” after the pause.");
      } else if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found") {
        setError("That email and password didn’t match. Check them, or use “Forgot password?” to reset your password.");
      } else if (code === "auth/email-already-in-use") {
        setError("An account already uses this email. Switch to sign in, or reset its password.");
      } else {
        const firebaseMessage = issue instanceof Error ? issue.message.replace(/^Firebase:\s*/i, "").replace(/\s*\(auth\/[^)]+\)\.?$/, "") : "";
        setError(firebaseMessage || "We couldn't complete that request. Please try again later.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    if (!auth.currentUser || resendSeconds > 0 || busy) return;
    setError("");
    setNotice("");
    setBusy(true);
    try {
      await sendEmailVerification(auth.currentUser);
      localStorage.setItem(retryKey(auth.currentUser.uid), String(Date.now() + 60_000));
      localStorage.removeItem(pendingErrorKey(auth.currentUser.uid));
      setResendSeconds(60);
      setNotice("A fresh verification link has been sent.");
    } catch (issue) {
      const message = authErrorMessage(issue);
      setError(message);
      localStorage.setItem(pendingErrorKey(auth.currentUser.uid), message);
      const code = typeof issue === "object" && issue !== null && "code" in issue ? String(issue.code) : "";
      if (code === "auth/too-many-requests") {
        localStorage.setItem(retryKey(auth.currentUser.uid), String(Date.now() + 5 * 60_000));
        setResendSeconds(5 * 60);
      }
    } finally {
      setBusy(false);
    }
  }

  if (verificationUser) {
    const savedError = localStorage.getItem(pendingErrorKey(verificationUser.uid));
    return <main className="auth-page auth-page-animated"><section className="auth-card verification-card">
      <div className="brand-mark"><MessageCircle size={22} /></div>
      <CheckCircle2 className="verification-icon" size={40} />
      <h1>Check your inbox</h1>
      <p>We sent a verification link to <strong>{verificationUser.email}</strong>. Check your inbox and spam/junk folder.</p>
      {savedError && !error && <p className="error-message">{savedError}</p>}
      <button className="primary-button full-button" onClick={resendVerification} disabled={busy || resendSeconds > 0}>
        {busy ? "Sending…" : resendSeconds > 0 ? `Resend available in ${resendSeconds}s` : "Resend verification email"}
        <ArrowRight size={17} />
      </button>
      <p className="verification-help">If it still doesn’t arrive, confirm the address is correct and check Firebase Console → Authentication → Templates for the email verification template.</p>
      {notice && <p className="success-message">{notice}</p>}
      {error && <div className="error-message">
        <p>{error}</p>
        {authSetupRequired && <ol className="auth-setup-steps">
          <li>Open Firebase Authentication for the Gather project.</li>
          <li>Select <strong>Get started</strong>, then open <strong>Sign-in method</strong>.</li>
          <li>Enable <strong>Email/Password</strong> and save. Then refresh this page.</li>
        </ol>}
        {authSetupRequired && <a className="auth-setup-link" href="https://console.firebase.google.com/project/gather-869c5/authentication/providers" target="_blank" rel="noreferrer">Open Firebase Authentication settings</a>}
      </div>}
      <button className="text-button" onClick={onVerifiedSession}>I've verified my email</button>
    </section></main>;
  }

  return <main className="auth-page">
    <section className="auth-intro">
      <span className="auth-orb auth-orb-one" aria-hidden="true" />
      <span className="auth-orb auth-orb-two" aria-hidden="true" />
      <div className="brand-lockup"><span className="brand-mark"><MessageCircle size={22} /></span><span>gather</span></div>
      <div className="intro-copy">
        <span className="eyebrow">A little closer, every day</span>
        <h1>Good conversations<br />start here.</h1>
        <p>A calm, thoughtful space for the people who make your day.</p>
        <div className="intro-decoration" aria-hidden="true"><span /><span /><span /><i /></div>
      </div>
      <div className="trust-note"><ShieldCheck size={17} /> Private conversations, built around you</div>
    </section>
    <section className="auth-panel">
      <div className="auth-card auth-card-animated">
        <div className="mobile-brand brand-lockup"><span className="brand-mark"><MessageCircle size={22} /></span><span>gather</span></div>
        <div className="form-heading" key={`${mode}-heading`}>
          <span className="eyebrow">{mode === "register" ? "Get started" : mode === "forgot" ? "Account recovery" : "Welcome back"}</span>
          <h2>{mode === "register" ? "Create your account" : mode === "forgot" ? "Reset your password" : "Sign in to Gather"}</h2>
          <p>{mode === "register" ? "Bring your favorite people together." : mode === "forgot" ? "We'll send a secure reset link to your inbox." : "Your conversations are right where you left them."}</p>
        </div>
        <form onSubmit={submit} className="auth-form" key={`${mode}-form`}>
          {mode === "register" && <label>Full name<input required autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="How should we call you?" maxLength={80} /></label>}
          <label>Email address<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
          {mode !== "forgot" && <label>Password<input required type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" minLength={6} /></label>}
          {mode === "login" && <div className="form-helper"><span>Secure sign-in</span><button type="button" className="text-button" onClick={() => setMode("forgot")}>Forgot password?</button></div>}
          {error && <p className="error-message">{error}</p>}
          {notice && <p className="success-message">{notice}</p>}
          <button className="primary-button full-button" disabled={busy}>{busy ? "Please wait…" : mode === "register" ? "Create account" : mode === "forgot" ? "Send reset link" : "Sign in"} <ArrowRight size={17} /></button>
        </form>
        <p className="auth-switch">
          {mode === "forgot" ? <button className="text-button" onClick={() => setMode("login")}>Back to sign in</button> : mode === "register" ? <>Already have an account? <button className="text-button" onClick={() => setMode("login")}>Sign in</button></> : <>New to Gather? <button className="text-button" onClick={() => setMode("register")}>Create an account</button></>}
        </p>
      </div>
      <p className="legal-note">By continuing, you agree to keep conversations respectful and private.</p>
    </section>
  </main>;
}

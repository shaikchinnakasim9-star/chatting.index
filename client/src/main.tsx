import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

const required = [
  ["VITE_FIREBASE_API_KEY", "API key"],
  ["VITE_FIREBASE_AUTH_DOMAIN", "Auth domain"],
  ["VITE_FIREBASE_PROJECT_ID", "Project ID"],
  ["VITE_FIREBASE_STORAGE_BUCKET", "Storage bucket"],
  ["VITE_FIREBASE_MESSAGING_SENDER_ID", "Messaging sender ID"],
  ["VITE_FIREBASE_APP_ID", "App ID"],
] as const;
const missing = required.filter(([key]) => !import.meta.env[key]);
const root = ReactDOM.createRoot(document.getElementById("root")!);

if (missing.length) {
  root.render(
    <main className="setup-page">
      <section className="setup-card">
        <div className="brand-lockup"><span className="brand-mark">g</span><span>gather</span></div>
        <span className="eyebrow">One quick setup step</span>
        <h1>Connect your Firebase project</h1>
        <p>Gather is running, but it needs your Firebase web app settings before sign-in and messaging can start.</p>
        <ol>
          <li>Copy <code>client\.env.example</code> to <code>client\.env</code>.</li>
          <li>In Firebase Console, open Project settings → General → Your apps.</li>
          <li>Copy the web app values into <code>client\.env</code> below.</li>
        </ol>
        <div className="missing-config">
          <strong>Values still needed</strong>
          {missing.map(([, label]) => <span key={label}>{label}</span>)}
        </div>
        <div className="setup-note">After saving <code>client\.env</code>, restart the dev server so Vite picks up the new settings.</div>
      </section>
    </main>,
  );
} else {
  void import("./App").then(({ default: App }) => {
    root.render(<React.StrictMode><App /></React.StrictMode>);
  }).catch((error: unknown) => {
    console.error("Gather could not start:", error);
    root.render(
      <main className="setup-page">
        <section className="setup-card">
          <div className="brand-lockup"><span className="brand-mark">g</span><span>gather</span></div>
          <h1>Gather couldn't start</h1>
          <p>Refresh the page. If the problem continues, check the browser console and restart the development server.</p>
        </section>
      </main>,
    );
  });
}

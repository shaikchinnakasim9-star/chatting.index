import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  console.error("API request failed:", { code, message });

  if (/browser origin is not allowed/i.test(message)) {
    res.status(403).json({ error: "This frontend origin is not allowed by the API CORS policy. Add it to CLIENT_ORIGIN or CLIENT_ORIGINS." });
    return;
  }
  if (code === "permission-denied") {
    res.status(403).json({ error: "Firebase denied this operation. Check Firestore access and server permissions." });
    return;
  }
  if (code === "unavailable" || /credential|application default|project id/i.test(message)) {
    res.status(503).json({ error: "Firebase services are unavailable. Check FIREBASE_PROJECT_ID and server-side Firebase Admin credentials." });
    return;
  }
  res.status(500).json({ error: "The API could not complete this request. Check the server logs for the underlying Firebase error." });
};

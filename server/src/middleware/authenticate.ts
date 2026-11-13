import type { NextFunction, Request, Response } from "express";
import { auth, db } from "../config/firebase.js";
import type { RequestHandler } from "express";

declare global {
  namespace Express {
    interface Request {
      user?: { uid: string; email?: string };
    }
  }
}

export function authenticate(options: { requireVerified?: boolean } = {}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }

    try {
      const decoded = await auth.verifyIdToken(header.slice(7), true);
      if (options.requireVerified !== false && !decoded.email_verified) {
        res.status(403).json({ error: "Verify your email address before using Gather." });
        return;
      }
      if (options.requireVerified !== false) {
        const account = await db.collection("users").doc(decoded.uid).get();
        const accountData = account.data();
        const expiresAt = accountData?.accountExpiresAt;
        if (accountData && Object.hasOwn(accountData, "accountExpiresAt")
          && (!expiresAt || typeof expiresAt.toMillis !== "function")) {
          console.error("Invalid account expiration timestamp:", { uid: decoded.uid });
          res.status(503).json({ error: "Account status could not be verified." });
          return;
        }
        if (expiresAt && expiresAt.toMillis() <= Date.now()) {
          res.status(403).json({ error: "Your Gather account has expired." });
          return;
        }
      }
      req.user = { uid: decoded.uid, ...(decoded.email ? { email: decoded.email } : {}) };
      next();
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown";
      if ([
        "auth/argument-error",
        "auth/id-token-expired",
        "auth/id-token-revoked",
        "auth/invalid-id-token",
        "auth/user-disabled",
      ].includes(code)) {
        res.status(401).json({ error: "Your session is invalid or expired. Please sign in again." });
        return;
      }

      console.error("Firebase ID token verification is unavailable:", {
        code,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error && /project id|credential|application default/i.test(error.message)) {
        res.status(503).json({ error: "Firebase Admin is not configured. Set FIREBASE_PROJECT_ID and valid server-side Application Default Credentials." });
        return;
      }
      res.status(503).json({ error: "Authentication service is temporarily unavailable." });
    }
  };
}

import type { NextFunction, Request, Response } from "express";
import { auth } from "../config/firebase.js";

declare global {
  namespace Express {
    interface Request {
      user?: { uid: string; email?: string };
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  try {
    const decoded = await auth.verifyIdToken(header.slice(7), true);
    if (!decoded.email_verified) {
      res.status(403).json({ error: "Verify your email address before using Gather." });
      return;
    }
    req.user = { uid: decoded.uid, ...(decoded.email ? { email: decoded.email } : {}) };
    next();
  } catch {
    res.status(401).json({ error: "Your session is invalid or expired. Please sign in again." });
  }
}

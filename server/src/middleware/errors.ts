import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error("API request failed:", error);
  res.status(500).json({ error: "An unexpected server error occurred." });
};

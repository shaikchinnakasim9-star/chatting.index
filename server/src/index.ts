import "dotenv/config";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { api } from "./routes/api.js";
import { errorHandler } from "./middleware/errors.js";

const app = express();
app.disable("x-powered-by");
app.use(helmet());
const configuredOrigins = ([process.env.CLIENT_ORIGIN, process.env.CLIENT_ORIGINS]
  .filter((origin): origin is string => Boolean(origin?.trim()))
  .join(",") || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => (/^https?:\/\//i.test(origin) ? origin : `https://${origin}`).replace(/\/+$/, "").toLowerCase());
app.use(cors({
  origin(origin, callback) {
    if (!origin || configuredOrigins.includes(origin.replace(/\/+$/, "").toLowerCase())) {
      callback(null, true);
      return;
    }
    console.error("Blocked API request from an unconfigured browser origin:", origin);
    callback(new Error("This browser origin is not allowed. Add it to CLIENT_ORIGIN or CLIENT_ORIGINS."));
  },
}));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", api);
app.use(errorHandler);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Gather API listening on port ${port}`));

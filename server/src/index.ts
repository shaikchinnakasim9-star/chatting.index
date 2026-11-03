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
const configuredOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
const clientOrigin = /^https?:\/\//i.test(configuredOrigin) ? configuredOrigin : `https://${configuredOrigin}`;
app.use(cors({ origin: clientOrigin }));
app.use(express.json({ limit: "1mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", api);
app.use(errorHandler);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => console.log(`Gather API listening on port ${port}`));

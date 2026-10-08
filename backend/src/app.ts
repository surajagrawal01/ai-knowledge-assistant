// backend/src/app.ts: BUILDS the app (no listening)
import express from "express";
import cors from "cors";
import { env } from "./core/env.js";


export const app = express();

app.use(cors({ origin: env.FRONTEND_URL }));
app.use(express.json({ limit: "100kb" }));      // parse JSON bodies, cap size

app.get("/health", (_req, res) => res.json({ ok: true }));

// One line per module, added as you build them:
// app.use("/api/extract", ticketExtractorRouter);   ← Step 1
// app.use("/api/agent",   supportAgentRouter);      ← Step 2
// app.use("/api/triage",  triageRouter);            ← Step 2

// Error middleware: 4 arguments tells Express "this handles errors"
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
});
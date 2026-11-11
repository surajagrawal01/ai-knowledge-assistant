import { Router } from "express";
import { TriageIdSchema, TriageRequestSchema } from "./triage.schema.js";
import { confirmTriage, rejectTriage, triage } from "./triage.service.js";

export const triageRouter = Router();

//   POST /api/triage   { "message": "..." }
//   400 { error: [zod issues] }      missing / empty / too-long message
//   200 TriageResponse               always a suggestion, even when the AI failed (then: escalate_to_human)
//   500 { error: "Internal server error" }   a bug (via the error middleware in app.ts)
triageRouter.post("/", async (req, res, next) => {
    const parsed = TriageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    try {
        res.json(await triage(parsed.data.message));
    } catch (err) {
        next(err);
    }
});

//   POST /api/triage/:triageId/confirm   (no body: the server uses ITS OWN copy of the proposal)
//   200 { ticketId, alreadyConfirmed }   idempotent: a repeat returns the same ticket
//   404 unknown or expired · 409 rejected, or nothing to create (action isn't create_ticket)
triageRouter.post("/:triageId/confirm", async (req, res, next) => {
    if (!TriageIdSchema.safeParse(req.params.triageId).success) {
        res.status(404).json({ error: "Unknown or expired triage" });
        return;
    }
    try {
        const result = await confirmTriage(req.params.triageId);
        if (result.ok) res.json(result.response);
        else res.status(result.status).json({ error: result.error });
    } catch (err) {
        next(err);
    }
});

//   POST /api/triage/:triageId/reject   → 200 { ok: true } · 404 unknown · 409 already confirmed
triageRouter.post("/:triageId/reject", (req, res) => {
    if (!TriageIdSchema.safeParse(req.params.triageId).success) {
        res.status(404).json({ error: "Unknown or expired triage" });
        return;
    }
    const result = rejectTriage(req.params.triageId);
    if (result.ok) res.json({ ok: true });
    else res.status(result.status).json({ error: result.error });
});

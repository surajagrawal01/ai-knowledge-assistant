import { Router } from "express";
import { ExtractRequestSchema } from "./ticket.schema.js";
import { extractTicket } from "./ticket-extractor.service.js";

export const ticketExtractorRouter = Router();

//   POST /api/extract   { "message": "..." }
//   400 { error: [zod issues] }        missing / empty / too-long message
//   200 { ok: true, ticket, ... }      extracted
//   200 { ok: false, reason }          valid request, the AI couldn't do it (not an HTTP error, rule 33)
//   500 { error: "Internal server error" }   a bug (via the error middleware in app.ts)
ticketExtractorRouter.post("/", async (req, res, next) => {
    const parsed = ExtractRequestSchema.safeParse(req.body);

    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    try {
        const result = await extractTicket(parsed.data.message);
        if (result.ok) {
            res.json(result);
        } else {
            // `details` can contain raw model output, keep it in server logs only.
            res.json({ ok: false, reason: result.reason });
        }
    } catch (err) {
        next(err);   // → app.ts error middleware → 500, real error logged server-side
    }
});
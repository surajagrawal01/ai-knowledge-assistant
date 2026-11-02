import { Router } from "express";
import { ChatRequestSchema } from "./support-agent.schema.js";
import { chat } from "./support-agent.service.js";

export const supportAgentRouter = Router();

//   POST /api/agent/chat   { "messages": [ { "role": "user", "text": "..." } ] }
//   400 { error: [zod issues] }                         invalid body (empty, roles don't alternate, last not user, too long)
//   200 { ok: true,  outcome: "answered", answer, trace, stats }
//   200 { ok: false, outcome, reason, answer: null, trace, stats }   valid request, the agent couldn't finish
//   500 { error: "Internal server error" }               a bug (via the error middleware in app.ts)
supportAgentRouter.post("/", async (req, res, next) => {
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
    }
    try {
        res.json(await chat(parsed.data.messages));
    } catch (err) {
        next(err);   // → app.ts error middleware → 500, real error logged server-side
    }
});

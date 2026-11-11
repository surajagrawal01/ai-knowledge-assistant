// npm run check:confirm — the confirm path on the REAL DB, no AI: store a proposal, confirm it
// twice (and twice at once), check one ticket was created, then delete it again.
import { prisma } from "../../src/core/prisma.js";
import { confirmTriage, rejectTriage, saveProposal, type TriageSuggestion } from "../../src/modules/triage/index.js";

const suggestion: TriageSuggestion = {
    action: "create_ticket",
    customer_id: "C002",
    order_id: "O020",
    verified: true,
    facts: ["check-confirm script"],
    proposed_ticket: { category: "delivery", priority: "medium", subject: "check-confirm: test ticket", description: "Created and deleted by scripts/triage/check-confirm.ts" },
    existing_ticket_id: null,
    reply_draft: "test",
};

const before = await prisma.ticket.count();
const p = saveProposal({ runId: null, suggestion, confirmable: true });
const [a, b] = await Promise.all([confirmTriage(p.id), confirmTriage(p.id)]);
const c = await confirmTriage(p.id);
const after = await prisma.ticket.count();
console.log({ a, b, c, rejectAfterConfirm: rejectTriage(p.id), created: after - before });

const ticketId = a.ok ? a.response.ticketId : null;
if (ticketId) {
    const row = await prisma.ticket.findUnique({ where: { id: ticketId } });
    console.log("row:", row?.id, row?.customerId, row?.orderId, row?.category, row?.status);
    await prisma.ticket.delete({ where: { id: ticketId } });
    console.log(`deleted ${ticketId}`);
}
const ok = after - before === 1 && a.ok && b.ok && c.ok && a.response.ticketId === b.response.ticketId && c.response.alreadyConfirmed;
console.log(ok ? "✅ one ticket, idempotent" : "❌ check failed");
await prisma.$disconnect();
if (!ok) process.exitCode = 1;

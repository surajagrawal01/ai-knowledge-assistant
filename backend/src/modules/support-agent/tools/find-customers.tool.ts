import { z } from "zod";
import { prisma } from "../../../core/prisma.js";
import { defineTool } from "./types.js";

const MAX_MATCHES = 5;
const MIN_PHONE_DIGITS = 7;

// "+91 99600 13389" and "9960013389" are the same phone: compare the last 10 digits only.
export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "").slice(-10);
}

const FindCustomersArgs = z
  .object({
    email: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[^\s@]+@[^\s@]+$/, "must be an email address")
      .nullable()
      .describe("Exact email address, if the message has one; otherwise null"),
    phone: z
      .string()
      .trim()
      .max(30)
      .refine((p) => phoneDigits(p).length >= MIN_PHONE_DIGITS, `must contain at least ${MIN_PHONE_DIGITS} digits`)
      .nullable()
      .describe("Phone number in any format, if the message has one; otherwise null"),
    name: z
      .string()
      .trim()
      .min(2)
      .max(100)
      .nullable()
      .describe("Full or partial customer name, if the message has one; otherwise null"),
  })
  // Refinements are NOT visible in the JSON Schema the model sees, so the description says it too.
  .refine((a) => a.email !== null || a.phone !== null || a.name !== null, {
    message: "Provide at least one of email, phone or name",
  });

type MatchField = "email" | "phone" | "name";
const STRENGTH: Record<MatchField, number> = { email: 3, phone: 2, name: 1 };

export const findCustomers = defineTool({
  name: "findCustomers",
  description:
    "Search customers when you DON'T have a customer ID. Provide at least one of email, phone or name and set " +
    "the others to null. Email and phone match exactly; name matches partially. Returns up to 5 matches with what " +
    "matched. If more than one customer matches, do not pick one yourself.",
  args: FindCustomersArgs,
  kind: "read",
  async run({ email, phone, name }) {
    const digits = phone === null ? null : phoneDigits(phone);

    const candidates = await prisma.customer.findMany({
      where: {
        OR: [
          ...(email !== null ? [{ email }] : []),
          ...(name !== null ? [{ name: { contains: name, mode: "insensitive" as const } }] : []),
          ...(digits !== null ? [{ phone: { not: null } }] : []),
        ],
      },
      select: { id: true, name: true, email: true, phone: true, city: true, tier: true },
    });

    const matches = candidates
      .map((c) => {
        const matchedOn: MatchField[] = [];
        if (email !== null && c.email.toLowerCase() === email) matchedOn.push("email");
        if (digits !== null && c.phone !== null && phoneDigits(c.phone) === digits) matchedOn.push("phone");
        if (name !== null && c.name.toLowerCase().includes(name.toLowerCase())) matchedOn.push("name");
        const strength = matchedOn.reduce((sum, field) => sum + STRENGTH[field], 0);
        // email/phone are only used to match: they are NOT returned (minimum personal data).
        return { id: c.id, name: c.name, city: c.city, tier: c.tier, matchedOn, strength };
      })
      .filter((m) => m.matchedOn.length > 0)
      .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));

    // "find" means 0..n results: an empty list is a normal answer, not an error.
    return {
      count: matches.length,
      truncated: matches.length > MAX_MATCHES,
      matches: matches.slice(0, MAX_MATCHES).map(({ strength: _strength, ...m }) => m),
    };
  },
});

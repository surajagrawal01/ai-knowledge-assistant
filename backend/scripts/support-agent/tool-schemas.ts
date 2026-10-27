// Build guide step 2: see what the MODEL sees, and how the ID schemas behave.
//   npm run schema:tools                   → every tool's name, description, JSON Schema
//   npm run schema:tools -- getOrder       → just one tool
// No DB query and no API call (the Prisma client is created but never used).
import { CustomerIdSchema, OrderIdSchema } from "../../src/modules/support-agent/tools/common.js";
import { READ_TOOLS, toToolSpecs } from "../../src/modules/support-agent/index.js";

const only = process.argv[2];
for (const spec of toToolSpecs(READ_TOOLS)) {
  if (only && spec.name !== only) continue;
  console.log(`\n━━ ${spec.name}`);
  console.log(spec.description);
  console.log(JSON.stringify(spec.parametersJsonSchema, null, 2));
}

console.log("\n━━ ID schemas (normalise, then check the format)");
for (const input of ["C002", " c002 ", "C2", "C0002", "customer 2", 2, null]) {
  const r = CustomerIdSchema.safeParse(input);
  console.log(`CustomerId ${JSON.stringify(input).padEnd(14)} → ${r.success ? `✅ ${r.data}` : `❌ ${r.error.issues[0]?.message}`}`);
}
for (const input of ["O020", "o020", "O20", "order 20"]) {
  const r = OrderIdSchema.safeParse(input);
  console.log(`OrderId    ${JSON.stringify(input).padEnd(14)} → ${r.success ? `✅ ${r.data}` : `❌ ${r.error.issues[0]?.message}`}`);
}

// npx tsx --env-file=.env scripts/support-agent/tool-schemas.ts getCustomerOrders
// npx tsx --env-file=.env scripts/support-agent/tool-schemas.ts          # all 7
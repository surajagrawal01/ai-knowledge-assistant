import { generateText } from "../src/core/llm.js";
import { prisma } from "../src/core/prisma.js";

const r = await generateText({ prompt: "What is customer C002's latest order?" });
console.log("LLM:", r.text, r.usage);

const count = await prisma.customer.count();
console.log("DB customers:", count);          // expect 20

await prisma.$disconnect();

// # Run the script To Test
//  npx tsx --env-file=.env scripts/smoke-test.ts
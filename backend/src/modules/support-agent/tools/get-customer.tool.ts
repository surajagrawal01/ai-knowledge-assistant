import { z } from "zod";
import { prisma } from "../../../core/prisma.js";
import { CustomerIdSchema, toolError } from "./common.js";
import { defineTool } from "./types.js";

const GetCustomerArgs = z.object({ customerId: CustomerIdSchema });

export const getCustomer = defineTool({
  name: "getCustomer",
  description:
    "Get one customer's profile by ID: name, email, city, state, tier (regular or premium). " +
    "Use when you already have a customer ID. If you only have an email, phone or name, use findCustomers instead.",
  args: GetCustomerArgs,
  kind: "read",
  async run({ customerId }) {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
      // No phone: nothing the agent answers needs it, so it doesn't go to the LLM (minimum personal data).
      select: { id: true, name: true, email: true, city: true, state: true, tier: true },
    });
    if (customer === null) return toolError("NOT_FOUND", `No customer with id ${customerId}`);
    return { ...customer };
  },
});

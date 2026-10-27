import type { ToolSpec } from "../../../core/llm.js";
import { checkOrderPolicy } from "./check-order-policy.tool.js";
import { findCustomers } from "./find-customers.tool.js";
import { getCustomerOrders } from "./get-customer-orders.tool.js";
import { getCustomerTickets } from "./get-customer-tickets.tool.js";
import { getCustomer } from "./get-customer.tool.js";
import { getOrder } from "./get-order.tool.js";
import { getPayment } from "./get-payment.tool.js";
import type { RegisteredTool, ToolRegistry } from "./types.js";

// Keys come FROM each tool's name to the tool object. 
// The model sees only the name + description + JSON Schema, not the code.

export function buildRegistry(tools: RegisteredTool[]): ToolRegistry {
  const registry: Record<string, RegisteredTool> = {};
  for (const tool of tools) {
    if (Object.hasOwn(registry, tool.name)) throw new Error(`Duplicate tool name "${tool.name}"`);
    registry[tool.name] = tool;
  }
  return Object.freeze(registry);
}

export const READ_TOOLS: ToolRegistry = buildRegistry([
  getCustomer,
  findCustomers,
  getCustomerOrders,
  getOrder,
  checkOrderPolicy,
  getPayment,
  getCustomerTickets,
]);

// What the model sees: name + description + JSON Schema per tool.
export function toToolSpecs(registry: ToolRegistry): ToolSpec[] {
  return Object.values(registry).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: tool.jsonSchema,
  }));
}

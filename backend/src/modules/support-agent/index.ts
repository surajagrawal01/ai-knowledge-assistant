// Public entry of the module. Scripts, evals and triage import from HERE only.
// B2 adds runAgent, chat and the router.
export { READ_TOOLS, toToolSpecs, buildRegistry } from "./tools/index.js";
export { defineTool, type ToolContext, type ToolRegistry, type ToolResult, type ToolError, type ToolErrorCode } from "./tools/types.js";
export { evaluateOrderPolicy, type OrderPolicy } from "./tools/order-policy.js";
export { executeTool, executeToolCalls, type ToolExecution } from "./tool-executor.js";
export { userMessage, toolResultsMessage } from "./history.js";
export { AGENT_SYSTEM_PROMPT } from "./support-agent.prompt.js";

// Public entry of the module. Scripts, evals and triage import from HERE only.
// B1: tools, executor, history.
export { READ_TOOLS, toToolSpecs, buildRegistry } from "./tools/index.js";
export { defineTool, type ToolContext, type ToolRegistry, type ToolResult, type ToolError, type ToolErrorCode } from "./tools/types.js";
export { evaluateOrderPolicy, type OrderPolicy } from "./tools/order-policy.js";
export { executeTool, executeToolCalls, type ToolExecution } from "./tool-executor.js";
export { userMessage, toolResultsMessage, fromVisibleChat, historySize } from "./history.js";
export { AGENT_SYSTEM_PROMPT } from "./support-agent.prompt.js";
// B2: the loop, the chat service and its endpoint.
export {
    runAgent,
    DEFAULT_MAX_STEPS,
    HARD_MAX_STEPS,
    type AgentOutcome,
    type AgentRunResult,
    type RunAgentInput,
} from "./agent-loop.js";
export { newRunId, type AgentRun, type TraceStep } from "./trace.js";
export { chat } from "./support-agent.service.js";
export { ChatRequestSchema, type ChatResponse, type VisibleMessage } from "./support-agent.schema.js";
export { supportAgentRouter } from "./support-agent.routes.js";

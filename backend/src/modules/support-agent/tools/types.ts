// Zod + JSON Schema, and core/llm.ts turns that into a provider declaration.
import { z } from "zod";

// A closed list, so evals and the UI can switch on it. B2 adds REPEATED_CALL and TOO_MANY_CALLS.
export const TOOL_ERROR_CODES = [
  "UNKNOWN_TOOL",
  "INVALID_ARGS",
  "NOT_FOUND",
  "OWNERSHIP_MISMATCH",
  "NOT_ALLOWED",
  "TOOL_FAILED",
  "RESULT_TOO_LARGE",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

// The ONE shape every failure takes. `message` is written for the model:
// short, actionable, no stack trace, no SQL. Extra fields are structured hints.
export type ToolError = { error: ToolErrorCode; message: string;[extra: string]: unknown };

// A shaped success object, or a ToolError. Always an object (Gemini's functionResponse needs one).
export type ToolResult = Record<string, unknown>;

// What the SERVER knows and the model must not control.
export type ToolContext = {
  runId: string;
  now: Date;                    // injected so tests and evals can pin the date
  customerId: string | null;    // the claimed customer (triage); null = internal support chat, sees everyone
  writesApproved: false;        // literally false in Mini 1: no write tool runs from the model (rule 19)
};

export type ToolKind = "read" | "write";

// What you write per tool: fully typed. `run` only ever receives validated args.
// R = the success shape, so `summarize` can read its fields without casts.
export type ToolDef<A, R extends ToolResult> = {
  name: string;
  description: string;           // a prompt: what it does, when to use it (vs siblings), what comes back
  args: z.ZodType<A>;
  kind: ToolKind;
  run: (args: A, ctx: ToolContext) => Promise<R | ToolError>;
  // B2: one short line for the trace (humans and evals, never the model). Only the tool knows which fact matters.
  summarize?: (result: R) => string;
};

export type InvokeOutcome =
  | { ok: true; result: ToolResult }
  | { ok: false; issues: z.ZodError["issues"] };   // args invalid: `run` was never called

// The type-erased version stored in a registry. Every tool looks the same from outside.
export type RegisteredTool = {
  name: string;
  description: string;
  kind: ToolKind;
  jsonSchema: Record<string, unknown>;
  invoke: (rawArgs: unknown, ctx: ToolContext) => Promise<InvokeOutcome>;
  summarize: ((result: ToolResult) => string) | null;   // only for SUCCESS results (trace.ts checks ok first)
};

export type ToolRegistry = Readonly<Record<string, RegisteredTool>>;

// Gemini's function-name rules: start with a letter, letters/digits/underscore, max 64.
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

// Why this exists: a registry holding ToolDef<{orderId}> and ToolDef<{customerId}> can't be
// typed without `any`. The closure keeps `A` inside, so `run` gets typed args, while
// the registry stores one uniform type. One schema → JSON Schema for the model AND safeParse for us.
export function defineTool<A, R extends ToolResult>(def: ToolDef<A, R>): RegisteredTool {
  if (!TOOL_NAME.test(def.name)) {
    throw new Error(`Invalid tool name "${def.name}"`);   // at startup, before any user sees it
  }
  if (def.description.trim() === "") {
    throw new Error(`Tool "${def.name}" needs a description: it's the only way the model knows when to use it`);
  }

  // `$schema` is metadata for validators, not part of a parameter declaration: keep the declaration minimal.
  const { $schema: _metadata, ...jsonSchema } = z.toJSONSchema(def.args);
  const summarize = def.summarize;

  return {
    name: def.name,
    description: def.description,
    kind: def.kind,
    jsonSchema,
    async invoke(rawArgs, ctx) {
      const parsed = def.args.safeParse(rawArgs);
      if (!parsed.success) return { ok: false, issues: parsed.error.issues };
      return { ok: true, result: await def.run(parsed.data, ctx) };
    },
    // The one cast in the tool layer: the registry erases R, and a success result is what `run` returned as R.
    summarize: summarize === undefined ? null : (result) => summarize(result as R),
  };
}

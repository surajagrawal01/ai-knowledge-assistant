# Tool Calling: Giving an LLM Safe, Read-Only Access to Live Business Data

> **Phase 2 · Mini 1 · Part B1** of the ElectroNest AI Operations Assistant.
> The language model **decides** which data it needs; the backend **validates, executes and controls** every request.

**Stack:** TypeScript (strict) · Node.js · Express · Prisma · PostgreSQL (Supabase) · Zod v4 · Google Gemini (`@google/genai`)

---

## Table of contents

1. [Overview](#1-overview)
2. [Why this exists](#2-why-this-exists)
3. [What it does](#3-what-it-does)
4. [How it works](#4-how-it-works)
5. [The tools](#5-the-tools)
6. [Design decisions](#6-design-decisions)
7. [Security model](#7-security-model)
8. [How it connects to the rest of the system](#8-how-it-connects-to-the-rest-of-the-system)
9. [Key Takeaway](#9-key-takeaway)

---

## 1. Overview

ElectroNest is a fictional Indian online electronics retailer. Its support team constantly answers questions such as *"What are C003's recent orders?"* or *"Is O028 still returnable?"*. Answering means opening an admin panel or writing SQL.

This part of the project lets Google Gemini answer those questions using **live data from the company database**, through **seven narrow, validated, read-only tools**. The model never sees the database and never runs anything itself. It produces a structured request ("call `getCustomerOrders` with `customerId: "C003"`"), and the backend decides whether and how to fulfil it.

```
Support agent: "Show me C003's recent orders"
      │
      ▼
Gemini  ──▶  getCustomerOrders({ customerId: "C003" })        the model DECIDES
      │
      ▼
Backend ──▶  validate → authorise → query → shape → log         the backend EXECUTES
      │
      ▼
Gemini  ──▶  "Ananya Iyer (C003) has 6 orders. The latest is O025 (NestPhone 12, delivered 3 days ago)..."
```

---

## 2. Why this exists

| Problem | Naive approach | Why it fails | This project's approach |
|---|---|---|---|
| The model has no access to company data | Ask it anyway | It admits ignorance or **invents** an answer | Tools give it real data on demand |
| The model needs data | Paste the whole database into the prompt | Expensive, slow, leaks every customer's data into every request | The model fetches only what it needs, through narrow doors |
| The model needs flexible queries | Let it write SQL | It could read anything or run destructive statements; hard to validate | Fixed, typed functions; the model only chooses one and fills in arguments |
| Business rules (return windows, delays) | Let the model calculate | LLMs are unreliable at date arithmetic and rule-checking | Rules are computed in code and returned as facts with reasons |
| The model's output is untrusted | Use the arguments directly | Wrong types, invented IDs, manipulated values reach the database | Every argument is validated with Zod before any query |

The underlying principle, used throughout the project: **the LLM decides, the code executes.** Anything that can be enforced in code is enforced in code; prompts only add guidance.

---

## 3. What it does

- Exposes **7 read-only tools** to the model, each with a name, a description written as instructions, and a JSON Schema generated from a Zod schema.
- Runs one **round of tool calling**: send the question and tool list → receive tool calls → validate and execute them → send results back → receive the answer.
- Returns every failure (unknown tool, invalid arguments, missing record, ownership violation, crash, timeout, oversized result) as a **structured error object the model can read and act on**, never as an exception.
- Computes ElectroNest's **business rules in code** (return windows, warranty, delivery delays, damaged-on-arrival window) from `FACTS.md`.
- Logs every tool call as one JSON line, with **personal data masked**.

Part B2 wraps this round in an **agent loop**, so the model can make several decisions in a row.

---

## 4. How it works

### Request flow (one round)

```
history = [ user: question ]
     │
     ▼
generateWithTools(system, history, toolSpecs)                    core/llm.ts — the only file that talks to Gemini
     │   retries 429/5xx/network ×3 · 30 s timeout · provider errors → LlmApiError
     ▼
{ toolCalls, assistantMessage }      empty toolCalls = the model is done
     │
history.push(assistantMessage)                                   the model's turn, unchanged
     │
executeToolCalls(toolCalls, READ_TOOLS, ctx)                     tool-executor.ts — never throws
     │   ① tool exists in this flow's registry?     → UNKNOWN_TOOL
     │   ② write tool without human approval?        → NOT_ALLOWED
     │   ③ arguments valid (Zod)?                    → INVALID_ARGS
     │   ④ runs within 5 s without crashing?         → TOOL_FAILED
     │   ⑤ result is a small JSON object?            → RESULT_TOO_LARGE / TOOL_FAILED
     │   ⑥ log one line, personal data masked
     ▼
history.push(toolResultsMessage(executions))                     one message, one result per call, same order
     │
generateWithTools(...)  →  final answer built from tool results
```

### Core building blocks

| Component | File | Responsibility |
|---|---|---|
| Provider boundary | `src/core/llm.ts` | `generateWithTools()`; converts the provider-neutral history to Gemini's format and back |
| Tool contract | `tools/types.ts` | `defineTool()`: one Zod schema produces both the JSON Schema for the model and the runtime validator |
| Shared helpers | `tools/common.ts` | ID schemas, error objects, relative days, currency conversion, ownership check |
| Business rules | `tools/order-policy.ts` | Pure function implementing `FACTS.md`; no database, no AI |
| Tools | `tools/*.tool.ts` | Seven read-only tools with shaped outputs |
| Registry | `tools/index.ts` | The allow-list of tools a flow may use |
| Executor | `tool-executor.ts` | The safety gate between the model's request and the database |
| History | `history.ts` | Builds conversation messages in the correct order |

---

## 5. The tools

| Tool | Arguments | Returns | Possible errors |
|---|---|---|---|
| `getCustomer` | `customerId` | name, email, city, state, tier | `NOT_FOUND` |
| `findCustomers` | `email`, `phone`, `name` (at least one) | up to 5 matches, with which field matched | none: zero matches is a valid answer |
| `getCustomerOrders` | `customerId`, `limit` | recent order summaries, total count | `NOT_FOUND` |
| `getOrder` | `orderId` | status, zone, items, amounts, relative dates | `NOT_FOUND`, `OWNERSHIP_MISMATCH` |
| `checkOrderPolicy` | `orderId` | per-item return and warranty status, delivery delay, damaged-on-arrival window, each with a reason | `NOT_FOUND`, `OWNERSHIP_MISMATCH` |
| `getPayment` | `orderId` | all payment records, latest status, whether already refunded | `NOT_FOUND`, `OWNERSHIP_MISMATCH` |
| `getCustomerTickets` | `customerId`, `status` | up to 10 existing tickets (no free-text descriptions) | `NOT_FOUND` |

`createTicket` is intentionally **not** a model tool. Anything that changes data runs only after a human confirms it (Part C).

---

## 6. Design decisions

| Decision | Reason |
|---|---|
| **One Zod schema per tool** generates both the model's JSON Schema and the runtime validator | The declaration and the validation can never drift apart |
| **Tool arguments are typed `unknown`** until validated | TypeScript prevents using model output before Zod has checked it |
| **The executor never throws**; failures are returned as `{ error, message }` | The model can explain a failure or try another path instead of the request crashing |
| **Business rules live in a pure function** (`evaluateOrderPolicy`) | Exact, testable with fixed dates, and the model only explains the result |
| **Rules are evaluated per item**, not per order | A laptop (10-day return) and a charger (7-day return) in one order have different answers |
| **Outputs are shaped**: plain numbers, relative days, only needed fields | Fewer tokens, no date arithmetic for the model, less personal data sent to the LLM |
| **Provider-neutral message types** (`user` / `assistant` / `tool`) | Only `core/llm.ts` knows Gemini's format; the provider can be swapped later |
| **The model's turn is sent back unchanged** | Gemini attaches hidden thought signatures that must be preserved |
| **IDs are normalised before validation** (`" o020 "` → `"O020"`) | Customers write IDs loosely; normalising costs nothing and removes a wasted round trip |
| **`findCustomers` returns zero matches as success** | A search with no results is an answer, unlike a lookup by ID |
| **Time comes from the context (`ctx.now`)**, never from `new Date()` inside tools | Tests and evaluations are reproducible |

---

## 7. Security model

| Threat | Mitigation | Enforced in |
|---|---|---|
| The model calls a dangerous or invented tool | Only registered tools exist; lookups use `Object.hasOwn` (so `constructor` / `__proto__` are rejected) | Registry + executor |
| The model sends malformed or invented arguments | Zod validation of every argument; the database rejects unknown IDs | Executor + tools |
| The model changes data | No write tools are given to the model; `writesApproved` is the literal type `false` | Registry + types |
| A customer asks about another customer's order | Ownership check when the request is on behalf of a specific customer; the error reveals nothing about the real owner | `checkOrderAccess` |
| Prompt injection hidden in ticket text | Ticket descriptions are never returned to the model | `getCustomerTickets` |
| Internal errors leak to the model or user | Generic error messages; real errors only in server logs | Executor |
| Personal data in logs | Email, phone and name arguments are masked; result bodies are never logged | `redactArgs`, `logToolCall` |
| Runaway cost or hanging requests | 5 s tool timeout, 8,000-character result cap, API timeout and bounded retries | Executor + `core/llm.ts` |

The guiding rule: **critical guarantees live in code; the prompt only adds guidance.**

---

## 8. How it connects to the rest of the system

| Stage | Relationship to this part |
|---|---|
| **Step 1: Structured output** | Same technique applied to tool arguments: a Zod schema → JSON Schema → validated model output |
| **Part B2: Agent loop** | Repeats this round until the model is done or a limit is reached. Reuses `generateWithTools`, `executeToolCalls`, `toolResultsMessage` and `READ_TOOLS` unchanged |
| **Part C: Triage** | Sets `ctx.customerId` from the extracted message to enforce ownership; adds a `submitTriage` finish tool; ticket creation only after human confirmation |
| **Mini 3: Assistant** | Imports the same module through its public entry point |


---

## 9. Key takeaway
> "Tool calling lets the model request one of my functions with arguments. The model decides; my backend validates the arguments, checks permissions, runs the query and returns a shaped result or a clear error. The model never touches the database, and nothing changes data without a human."

---
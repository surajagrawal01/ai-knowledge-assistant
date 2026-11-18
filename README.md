# AI Operations Assistant

AI Operations Assistant is a full-stack demo for helping an electronics support team turn a customer's messy message into a verified support ticket.

The project uses a web interface for support agents and an Express API for AI and database operations. It is built around a simple safety rule:

> The AI can read and recommend, but it cannot create a ticket until a human approves.

## What the project does

The current application supports the following flow:

1. A support agent pastes a customer message into the Triage page.
2. The ticket extractor reads the message and identifies:
   - the customer
   - the order
   - the support category
   - the priority
   - the requested action
   - whether the message needs human review
3. The support agent uses read-only tools to check live PostgreSQL data.
4. The system applies the ElectroNest business rules in code.
5. It produces a suggested ticket or recommends escalation to a human.
6. The support agent can confirm or reject the suggestion.
7. The backend creates the ticket only after confirmation.

The interface also provides a follow-up chat for asking additional questions about customers, orders, payments, tickets, and policies.

## Current features

### Ticket extraction

- Converts unstructured customer messages into structured ticket data.
- Uses Google Gemini for extraction.
- Validates AI output with Zod schemas.
- Falls back to human review when extraction is not reliable.

### Support data agent

- Uses seven read-only tools to access live business data:
  - find a customer
  - find customers
  - get customer orders
  - get an order
  - check order policy
  - get payment information
  - get a customer's tickets
- Supports follow-up conversations without giving Gemini direct database access.
- Masks personal data in tool-call logs.
- Returns structured outcomes and tool traces for transparency.

### Triage and human approval

- Combines extraction, database checks, and business rules into one triage request.
- Stores the proposed ticket on the backend.
- Requires an explicit confirm or reject action from the user.
- Prevents the AI from editing or directly creating data.
- Makes confirmation idempotent, so repeated requests do not create duplicate tickets.
- Rejects invalid, unknown, expired, or already-confirmed proposals safely.
- Keeps confirmation proposals in memory for 30 minutes.

### Business rules

The system implements rules from `knowledge-base/facts.md`, including:

- return and warranty periods
- damaged-on-arrival handling
- refund methods
- failed-payment handling
- shipping delays
- cancellation rules
- premium-customer priority increases
- immediate escalation for safety concerns

### User interface

- Backend connection status on the home page.
- Ticket Triage workspace at `/triage`.
- Separate panels for extraction, database checks, and the suggested outcome.
- Visible tool trace and model usage statistics.
- Follow-up support chat.

## Next implementation roadmap

The current repository completes Mini 1: the Ticket Triage Agent. The top-level implementation planned after this is:

### Mini 2: Knowledge Assistant

- Extract text and tables from policy PDFs.
- Split documents into meaningful chunks.
- Create embeddings for document chunks.
- Store embeddings in PostgreSQL using `pgvector`.
- Implement semantic search over company policies.
- Build a Retrieval-Augmented Generation (RAG) flow.
- Return policy answers with page and section citations.
- Handle retrieval misses safely instead of guessing.
- Evaluate answers against known policy questions.

Planned knowledge sources include refund, return, shipping, warranty, product manual, and FAQ documents.

### Mini 3: Combined Ops Assistant

- Combine live database tools with policy retrieval.
- Reuse the existing support-agent loop and triage workflow.
- Add conversational memory for the current support session.
- Store useful facts instead of every raw conversation message.
- Add a unified assistant interface for customer data and company policies.
- Show both tool activity and policy citations in the UI.
- Keep create/update actions behind confirmation.
- Add persistent proposal, memory, and session storage for multi-instance deployments.

An example end-to-end goal is:

> Find premium customers with unresolved tickets who have not ordered in 90 days, then explain the refund policy for their latest orders.

The roadmap also includes authentication, authorization, production deployment, monitoring, and persistent storage. These are planned additions rather than completed features.

## AI concepts and learning outcomes

This project is useful for demonstrating the following AI engineering topics at a hiring or portfolio level.

### Structured output

- Converting free-form text into typed JSON.
- Defining and maintaining Zod schemas.
- Using JSON/structured-output mode with a language model.
- Retrying invalid model output with validation feedback.
- Checking extracted IDs against the original message.
- Separating extraction from database truth.

### Tool calling

- Giving an LLM a closed set of read-only tools.
- Generating tool schemas from Zod definitions.
- Validating model-generated arguments before execution.
- Keeping database access inside the backend.
- Returning structured success and error results to the model.
- Preventing write tools from being called without approval.

### Agent loops

- Building multi-step model-to-tool conversations.
- Stopping on a text answer or a dedicated finish tool.
- Limiting model calls and steps.
- Passing tool results back to the model.
- Recording a readable execution trace.
- Handling model, timeout, tool, and quota failures.

### Human-in-the-loop AI

- Keeping the AI in a recommendation role.
- Storing a server-owned ticket proposal.
- Requiring explicit user confirmation before database writes.
- Supporting confirm, reject, expiry, and idempotency behavior.
- Preventing a browser or model from editing proposed data.

### Grounding and reliability

- Using live database records instead of relying on model memory.
- Applying business rules in deterministic code.
- Escalating uncertain or safety-sensitive requests.
- Blocking customer or order ownership mismatches.
- Using plain-code fallbacks when AI extraction or agent execution fails.
- Logging and exposing tool traces for explainability.

### Evaluation and testing

- Testing pure business rules without calling an AI provider.
- Creating offline tests for schemas, stores, and confirmation behavior.
- Running model-based evaluation cases.
- Using pauses and limited case runs to manage provider rate limits.
- Separating unit tests, database checks, and live-model evaluations.

### Planned AI topics

The next stages extend these foundations into:

- PDF text and table extraction
- Chunking strategies
- Embeddings and vector similarity
- PostgreSQL vector search with `pgvector`
- Semantic retrieval
- Retrieval-Augmented Generation
- Source-grounded answers and citations
- Context and memory management
- Combined RAG, tool, and agent workflows
- Persistent state for proposals and sessions

## Technology

| Area | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS 4, TypeScript |
| Backend | Node.js, Express 5, TypeScript |
| Database | PostgreSQL through Prisma 7 |
| AI provider | Google Gemini through `@google/genai` |
| Validation | Zod |
| Development | npm workspaces-style root scripts and `concurrently` |

## Project structure

```text
.
├── backend/
│   ├── prisma/
│   │   ├── migrations/       # Database migrations
│   │   ├── seed-data/        # Fictional sample data
│   │   └── schema.prisma     # Database models and enums
│   ├── scripts/              # Manual and verification scripts
│   ├── evals/                # Agent, extraction, and triage evaluations
│   └── src/
│       ├── core/             # Environment, Gemini, and Prisma setup
│       └── modules/
│           ├── ticket-extractor/
│           ├── support-agent/
│           └── triage/
├── frontend/
│   └── src/
│       ├── app/              # Next.js pages
│       ├── components/       # Triage and chat components
│       └── lib/              # API and shared frontend types
└── knowledge-base/
    └── facts.md              # ElectroNest support policies
```

## Main API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Check whether the backend is running |
| `POST` | `/api/extract` | Extract structured ticket fields from a message |
| `POST` | `/api/agent/chat` | Ask the support agent a follow-up question |
| `POST` | `/api/triage` | Analyze a customer message and create a server-side proposal |
| `POST` | `/api/triage/:triageId/confirm` | Create the proposed ticket after human approval |
| `POST` | `/api/triage/:triageId/reject` | Reject the proposed ticket |

## Prerequisites

Install or prepare:

- Node.js 20 or newer
- npm
- PostgreSQL or a hosted PostgreSQL database
- A Google Gemini API key

## Environment setup

Create `backend/.env` using `backend/.env.example`:

```env
PORT=4000
FRONTEND_URL=http://localhost:3000,http://localhost:5173
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=your_gemini_model_name
DATABASE_URL=your_postgresql_connection_string
DIRECT_URL=your_direct_postgresql_connection_string
```

Create `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:4000
```

## Installation

Install dependencies for the root, backend, and frontend:

```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

Apply the database migrations:

```bash
npm run db:migrate --prefix backend
```

Load the fictional sample data:

```bash
npm run db:seed --prefix backend
```

## Running the project

Start both the backend and frontend from the project root:

```bash
npm run dev
```

Open:

- Frontend: `http://localhost:3000`
- Triage page: `http://localhost:3000/triage`
- Backend health check: `http://localhost:4000/health`

You can also run the parts separately:

```bash
npm run dev --prefix backend
npm run dev --prefix frontend
```

## Available backend scripts

Run these from `backend/` or use `npm run <script> --prefix backend` from the project root.

| Script | Purpose |
|---|---|
| `dev` | Start the API with file watching |
| `build` | Compile TypeScript |
| `start` | Run the compiled backend |
| `smoke` | Run the smoke test |
| `db:migrate` | Run Prisma migrations in development |
| `db:reset` | Reset the database |
| `db:seed` | Insert the sample ElectroNest data |
| `test:agent` | Test the support-agent loop |
| `try:agent` | Try the support agent manually |
| `eval:agent` | Run support-agent evaluations |
| `eval:extract` | Run ticket-extraction evaluations |
| `test:triage` | Run offline triage tests |
| `eval:triage` | Run triage evaluations against the configured model |
| `check:confirm` | Check ticket confirmation against the real database |

Example:

```bash
npm run test:triage --prefix backend
npm run db:seed --prefix backend
```

## Database

The Prisma schema includes models for:

- customers
- products
- orders
- order items
- payments
- tickets

The seed script replaces the existing data in these tables with deterministic sample data for local testing.

## Safety and design boundaries

- The model does not receive database credentials or run SQL.
- Database access is available only through predefined, validated read-only tools.
- Tool arguments are checked before they reach Prisma.
- Support-agent and extraction failures use structured responses instead of crashing the API.
- The model cannot create or update a ticket directly.
- Ticket creation happens only through the human-confirmation endpoint.
- Triage proposals contain server-owned data, not editable client-supplied ticket fields.
- Triage proposals are in-memory and expire after 30 minutes.
- An in-memory proposal store is suitable for a single local server instance, but is not persistent across restarts or multiple backend instances.
- The current project does not include authentication or authorization. It should be run locally or used as a demo until those controls are added.
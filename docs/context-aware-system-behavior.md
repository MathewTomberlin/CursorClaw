# Context-aware system behavior (tech spec)

**Scope:** Define when to use **minimal/tool-focused** vs **richer text-generation** system behavior for Ollama (and, if applicable, other local providers) so the agent gets both reliable tool use when expected and better, creative, contextual text when the turn is user-facing or conversational.

**Status:** Implemented. Runtime uses `shouldUseMinimalToolContext` when `ollamaContextMode: "auto"`; config supports `ollamaContextMode?: "auto" | "minimal" | "full"`; unit tests in `tests/context-aware-system-behavior.test.ts`. Docs updated: Ollama-tool-call-support §7, local-ollama-agent-setup §8, configuration-reference §4.15.

**References:** [Ollama-tool-call-support](Ollama-tool-call-support.md) §7 and "Future improvement"; [local-ollama-agent-setup](local-ollama-agent-setup.md) for current tuning.

---

## 1. Goals and problem

### Current behavior

- **Minimal/tool-focused:** When `toolTurnContext: "minimal"` and (for Ollama) `ollamaMinimalSystem: true`, the runtime:
  - Sends only the latest user message (plus system) for that turn.
  - Uses a short system message (how to use exec to read/edit files).
  - Injects AGENTS.md, IDENTITY.md, and SOUL.md so the agent has substrate.
  - Prepends to the user message: "You must respond by calling one or more of the provided tools… User request: …"

  This **improves reliable tool calling** (Ollama models like Qwen3 8B and Granite 3.2 then emit `tool_calls` instead of answering from context).

- **Richer/full context:** When those options are not set, the runtime sends full conversation history and a richer system block (AGENTS, memory, roadmap, etc.) and does not force "use tools" in the user message.

### Problem

Minimal/tool-focused behavior can **reduce the quality of user-facing or creative text** (e.g. roleplay, summaries, explanations, follow-up chat) because the model is optimized for tool use, not for long-form or stylistic output. Users want:

- **Reliable tool use** when the turn involves files, substrate, or workspace actions.
- **Richer, more creative, contextual text** when the turn is conversational, explanatory, or creative and tools are secondary or not needed.

### Goal

**Infer when tools are expected** and apply minimal/tool-focused behavior only then; **use richer text-generation behavior** when the turn is expected to produce user-facing or creative content. No single global setting—behavior chosen per turn (or per session phase) based on heuristics or signals.

---

## 2. Success criteria

- When the runtime infers that **tools are expected** (e.g. user asks to edit a file, update substrate, or run a command): use minimal/tool-focused behavior so the Ollama model reliably calls tools. Behavior should match or improve on current `toolTurnContext: "minimal"` + `ollamaMinimalSystem: true` for those turns.
- When the runtime infers that **user-facing or creative text** is primary (e.g. "explain X", "summarize", "write a short story", open-ended chat): use richer system/context so the model can produce better, more contextual, and prompted text without being forced to call tools.
- **Config compatibility:** Existing config (e.g. explicit `toolTurnContext: "minimal"` and `ollamaMinimalSystem: true`) continues to work; optional **context-aware mode** (e.g. `ollamaContextMode: "auto"` or a new top-level/agent setting) enables inference. No breaking change to current behavior when not opted in.
- **Documentation:** This spec and [Ollama-tool-call-support](Ollama-tool-call-support.md) §7 / [local-ollama-agent-setup](local-ollama-agent-setup.md) are updated to describe when to use manual vs auto context mode.

---

## 3. Signals and heuristics (design)

The following are candidate signals to **choose minimal vs richer** behavior per turn. Implementation will pick a subset and define precedence.

| Signal | Description | Use minimal when |
|--------|-------------|------------------|
| **Tool availability** | `toolRouter.list().length > 0` | Tools are provided this turn. |
| **User intent (keywords)** | Simple keyword/heuristic on latest user message | Message contains file/substrate/workspace/edit/run/update-style language. |
| **User intent (structured)** | Optional future: NLU or intent classifier | Classifier says "tool" or "action". |
| **Turn type / session phase** | First turn vs follow-up; or "agent task" vs "chat" | Session or UI marks turn as "agent task" or "tool turn". |
| **Explicit config override** | `toolTurnContext: "minimal"`, `ollamaMinimalSystem: true` | User set minimal explicitly → always minimal when tools present. |
| **Explicit config override** | `toolTurnContext: "full"`, `ollamaMinimalSystem: false` | User set full → always richer. |

**Recommended first step:** Prefer **explicit config** when set; otherwise use **tool availability** plus **optional keyword heuristic** on the latest user message (e.g. file paths, "edit", "update", "run", "read", "write" to file, "substrate", "ROADMAP", "MEMORY") to choose minimal. Default for "auto" mode when uncertain: **minimal when tools are provided** (safe for tool reliability); optionally allow a config knob to default to richer when uncertain for more creative-heavy use cases.

---

## 4. Configuration shape (proposed)

- **Existing:** `toolTurnContext: "full" | "minimal"` and `ollamaMinimalSystem: boolean` remain; when set, they override any auto behavior.
- **New (optional):** e.g. `ollamaContextMode: "auto" | "minimal" | "full"` on the model entry:
  - `"minimal"`: same as today’s minimal + `ollamaMinimalSystem: true` when tools present.
  - `"full"`: always richer (no forced "use tools" prepend; full context).
  - `"auto"`: use heuristics above to pick minimal vs richer per turn; when heuristics say "tools expected", use minimal; otherwise use richer.

Naming and placement (model-level vs profile-level) can be refined in implementation; config reference and runbook will be updated accordingly.

---

## 5. Implementation outline

- **Runtime** (`src/runtime.ts`): In the path that builds `messages` for the turn, add a step that decides "use minimal/tool-focused for this turn" vs "use richer". When context-aware mode is enabled, call a small helper (e.g. `shouldUseMinimalToolContext(toolList, lastUserMessage, modelConfig)`) that implements the chosen heuristics; when disabled, keep current behavior from `toolTurnContext` and `ollamaMinimalSystem`.
- **Config** (`src/config.ts`): Add optional field(s) for context mode (e.g. `ollamaContextMode`) and document in [configuration-reference](configuration-reference.md) §4.15.
- **Tests:** Unit tests for the decision helper (keyword heuristic, tool availability, config override); optionally one integration or E2E that runs one turn with "edit file" (expect minimal) and one with "explain X" (expect richer) and asserts behavior or outcome.
- **Docs:** Update [Ollama-tool-call-support](Ollama-tool-call-support.md) §7 "Future improvement" to point to this spec and to "Implemented" once done; update [local-ollama-agent-setup](local-ollama-agent-setup.md) to describe when to use auto vs manual minimal/full.

---

## 6. Out of scope (this spec)

- Full NLU or intent classifier; only simple heuristics in scope for the first implementation.
- Non-Ollama providers: design is applicable to other local providers (e.g. LM Studio) if they adopt similar minimal-vs-full behavior later; this spec focuses on Ollama.

---

## 7. Completion

Implemented: `src/config.ts` (ollamaContextMode), `src/runtime.ts` (shouldUseMinimalToolContext + buildPromptMessages integration), `tests/context-aware-system-behavior.test.ts` (unit tests). ROADMAP and referenced docs updated. No branch/PR required when committed on main.

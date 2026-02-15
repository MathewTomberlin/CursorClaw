# CursorClaw repo guidelines (for AI/editors that edit this codebase)

This file is **not** loaded into the running CursorClaw agent's system prompt. It is for contributors and AI tools that edit the repository (e.g. via CLAUDE.md symlink).

## Build and test

- `npm run build` – TypeScript build
- `npm test` – run tests (Vitest)
- Substrate files live under `src/substrate/`; config in `src/config.ts`; runtime injection in `src/runtime.ts`

## Security

- Do not put secrets in substrate files (IDENTITY.md, SOUL.md, BIRTH.md, CAPABILITIES.md, USER.md, TOOLS.md); they are included in the agent prompt.
- Capability enforcement is via `CapabilityStore` and approval workflow only; CAPABILITIES.md is informational.

## Substrate

- Identity, Soul, Birth, User, Tools: see `docs/IDENTITY_SOUL_BIRTH_IMPLEMENTATION.md` and `docs/configuration-reference.md` (section 4.16).

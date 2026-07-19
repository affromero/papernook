<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes. APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# papernook

Self-hosted paper library: one-tap capture from Safari/Chrome, iPad Pencil
annotation over WebDAV, per-paper AI chats through the user's own agent.
Architecture diagram (code-accurate) in README.md.

## Core invariants (do not break)

- **The filesystem is the source of truth.** Two trees:
  `data/papers/<topic>/<slug>.pdf` (+ `<slug>.exercises.pdf`) is the
  WebDAV-shared annotatable artifact; `data/library/<topic>/<slug>/` is the
  app-private companion (meta.json, summary.md, text.txt,
  chats/<username>/*.jsonl, crops/, canvas.json, exercises/). Unconfirmed
  captures live in `data/library/_inbox/<slug>/` with the PDF _inside_ the
  companion dir. Nothing unconfirmed may ever surface over WebDAV.
- **SQLite (`data/index.db`) is a rebuildable index, never truth.** Any query
  is only as fresh as the last `rebuildIndex()`; deleting the DB must always
  be safe. The chokidar scanner reconciles from disk; disk always wins.
- **The AI provider is never hardcoded.** `AI_PROVIDER` env (set by
  `scripts/install.sh` or `.env`) selects anthropic | openai | claude-code |
  codex | ollama | llamacpp | vllm; SSH modes via `CLAUDE_CODE_SSH_HOST` /
  `CODEX_SSH_HOST`. All
  provider calls go through `src/lib/agent/registry.ts`; never spawn a CLI
  or hit an AI API from feature code.
- **Per-account privacy**: chats and capture tokens belong to a profile;
  the paper library, annotations, and canvases are shared. WebDAV serves
  `data/papers` ONLY (docker-compose); never widen it.
- **PDF rewrites** (expand.ts) must be atomic (tmp + rename), grow only on
  far edges (origin fixed, existing ink coordinates must never shift), and
  respect the recent-write guard (iPad may be mid-save).
- **Slugs are the path-safety boundary**: every topic/slug/username that
  touches a path goes through `assertSlug`/`isValidSlug`
  (`src/lib/library/slug.ts`).

## Layout

| Where              | What                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `src/lib/library/` | papers, chats, index-db, scanner, slug, exercises, expand, chat-context                        |
| `src/lib/agent/`   | provider registry, CLI/API/OpenAI-compatible local clients, attachments (images per transport) |
| `src/lib/capture/` | normalize (URL matrix), download (polite fetch), analyze (agent filing), orchestration         |
| `src/lib/auth/`    | users (profiles on disk), session (HMAC cookies), rate-limit, avatars                          |
| `src/app/add/`     | token-authed capture endpoint + logged-out HTML confirmation pages                             |
| `src/app/api/v1/`  | session-authed JSON APIs (Zod-validated inputs)                                                |
| `src/components/`  | CSS Modules only; no Tailwind, no inline styles                                                |

## Commands

```bash
npm run dev            # local dev
npm run ci             # lint + typecheck + vitest + build (run before every commit)
pre-commit install --install-hooks   # two-tier gate (commit: hygiene+lint+tsc; push: test+build)
```

## Rules

- TypeScript strict; no `any`. Zod on every API input. Server Components by
  default; `"use client"` only when required.
- Tests are behavioral, mock only at system boundaries (spawn/ssh/fetch/fs
  temp dirs); see `tests/`. Update tests in the same change as source.
- Files < 1000 lines; ≤ 10 new files per directory (pre-commit enforces both).
- Commit style: `area: imperative summary` + Problem/Approach/Result body.
  No Conventional Commits, no Co-Authored-By.
- better-sqlite3 stays in `serverExternalPackages` and compiles inside the
  Docker image; never copy a macOS-built binary.

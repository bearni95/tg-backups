# tg-backups

`tgb`, a command line tool that stores zip backups in Telegram groups. Follow these conventions strictly to keep the codebase consistent.

## Project Structure

```
src/
├── cli/                  # The `tgb` binary: commander program and terminal I/O
│   ├── index.ts          # Entry point (bundled to dist/cli.js)
│   ├── program.ts        # Builds the commander program
│   ├── context.ts        # Opens the engine, resolves --group, prints errors
│   ├── progress.ts       # Upload and restore progress bars
│   └── commands/         # One file per command family
├── lib/                  # The backup engine; knows nothing about the terminal
│   └── telegram/         # Telegram storage (read its CLAUDE.md first)
├── adapters/classes/     # Data transformation, including what the CLI prints
├── types/                # TypeScript type definitions
└── utils/                # Pure utility functions
test/
├── cli/                  # `tgb` end to end, against the fake Telegram
├── engine/               # Engine tests, and support/ (fake Telegram, harness)
├── adapters/
└── utils/
```

### Path Aliases

```typescript
$lib      → src/lib/*
$adapters → src/adapters/*
$types    → src/types/*
$utils    → src/utils/*
```

They are set in `tsconfig.json` (for tsc, tsup and tsx) and in `vitest.config.ts`. Keep the two in step.

### Libraries

- `commander` parses commands and options. `@inquirer/prompts` asks questions. `cli-progress` draws progress bars. `log-update` redraws the login QR in place. `qrcode-generator` draws QR codes.
- Reach for a maintained package before writing terminal plumbing by hand.
- `tsup` bundles `src/cli/index.ts` into `dist/cli.js`. Dependencies stay external. Keep `removeNodeProtocol: false`, or `node:sqlite` breaks.

---

## Engine

- Read `src/lib/telegram/CLAUDE.md` before touching it: several on-disk and on-Telegram formats must not change.
- Backup groups are created and chosen with `tgb groups`, never configured through the environment.
- `src/lib` never prints, prompts or exits. It throws `StorageError`, and logs through `$lib/logger`, which writes to stderr and shows info lines only with `--verbose`.

## CLI

- Command handlers only parse arguments, call `src/lib`, and print the result. Logic that is not about the terminal belongs in `src/lib`.
- Every command runs inside `withStorage` from `context.ts`. It closes the client (which saves the session) and turns errors into `error: …` plus a hint, with exit code 1.
- Results go to stdout, everything else to stderr: progress, prompts' context, notes. Output on stdout must stay usable in a pipe.
- Commands that list things take `--json`. Use `printJson`, never hand-built JSON.
- Destructive commands confirm first and take `-y, --yes` to skip it. `delete-all` never defaults to the chosen group.
- Never print credentials, codes, passwords or session contents. `credentials show` prints the API id only.
- Commands that work on backups take `-g, --group <id or title>` and default to the chosen group, through `resolveGroup`.

---

## Adapters

Adapters transform data between formats. **All data transformation logic belongs in adapters, not in command handlers.** That includes what the CLI prints: tables, user names and warnings live in `cli-display.adapter.ts`.

```typescript
import { AdapterClass } from '$adapters/classes/adapter.class';

export class UserAdapter extends AdapterClass {
	constructor() {
		super('user');
	}

	fromApi(apiUser: ApiUser): User {
		return { id: apiUser.user_id, fullName: `${apiUser.first_name} ${apiUser.last_name}` };
	}
}

export const userAdapter = new UserAdapter();
```

1. **Always create static instances** for adapters (singleton pattern)
2. **Name methods clearly**: `fromApi`, `toApi`, `toDisplayFormat`, etc.
3. **Keep transformations pure** - no side effects
4. **Type both input and output** for type safety

---

## Type Definitions

Define shared types in `src/types/`. Use the `ID` type from `$types/core.type` for entity identifiers.

## Utilities

Utilities are **pure functions** with no side effects, one concern per file:

```typescript
// src/utils/string/slugify.ts
export function slugify(text: string): string {
	return text.toLowerCase().trim().replace(/\s+/g, '-');
}
```

---

## Testing

```bash
pnpm test           # Run all tests
pnpm check          # Type check
pnpm build          # Bundle dist/cli.js
pnpm tgb <command>  # Run the CLI from source
```

- Tests never reach Telegram: use `test/engine/support/fake-telegram.ts`.
- `useBackend()` from `test/engine/support/harness.ts` gives each test a temporary data root and a fake Telegram. Its `tgb(...args)` runs the real commander program and returns `{ code, stdout, stderr }`.
- CLI tests that prompt mock `@inquirer/prompts` and queue the answers.
- Test files start with `// @vitest-environment node`.

---

## Git Workflow

This project is a git repository. Commit your work automatically:

- After finishing each change, stage and commit everything (`git add -A` then `git commit`) without waiting to be asked.
- Never credit Claude: no `Co-Authored-By` trailers, no "Generated with Claude Code" lines, and no mention of Claude or AI in commit messages.
- Keep commit messages simple: one short, plain line describing the change (for example `Add settings page`). No em-dashes, no emoji.
- Use the default git identity already configured on the machine. Never set or change `user.name` / `user.email` and never pass `--author`. If no identity is configured and the commit fails, tell the user instead of making one up.

---

## Quick Reference Checklist

When implementing a new command or feature:

- [ ] Create types in `src/types/` if needed
- [ ] Put the behaviour in `src/lib`, throwing `StorageError`
- [ ] Put printed formats in an adapter, and pure helpers in `src/utils/`
- [ ] Register the command in `src/cli/commands/`, running inside `withStorage`
- [ ] Results to stdout, the rest to stderr; `--json` for listings; `--yes` for destructive commands
- [ ] Write tests in `test/` (engine behaviour, and the command through `backend.tgb`)
- [ ] Use path aliases (`$lib`, `$adapters`, `$utils`, `$types`)
- [ ] Update `README.md` when commands or options change
- [ ] Commit all changes (simple message, no Claude credit or co-author)

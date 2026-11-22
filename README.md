# tg-backups

Create and restore zip backups using Telegram groups as storage.

## Setup

1. With Node 24 or later, `pnpm install`
2. Start the app (below) and enter an API id and hash from https://my.telegram.org/apps. They can also go in `.env` (`cp .env.example .env`).
3. Sign in with Telegram. Creating a group needs an account: the id and hash only identify the app.
4. Create a group in the app, or choose one the account is already in.

## Run

- Development: `pnpm dev`, then open http://localhost:5173
- Built app: `pnpm start`, then open http://localhost:9811 (`TGB_PORT` changes it)
- Tests: `pnpm test`

The backend runs inside SvelteKit, so each of these is a whole app. Run one at a time on a data folder: they share the Telegram session and the index.

Start the built app with `pnpm start` or `node server.ts`, not `node dist`, which listens on every interface and limits uploads to 512 KB.

## How it works

- Backups live in Telegram groups that you create or choose in the app. You can have several and switch between them; an upload stays with the group it started in.
- Created groups are private, with history visible to new members and auto-delete off. Use Share to invite someone: every member can see and delete the backups.
- Groups are remembered per account. On another machine, sign in and pick the group under "Use an existing group".
- Zips are split into 50 MiB MTProto chunks with metadata captions, up to 200 GiB per zip.
- Small zips can be picked in the browser. For large ones, put the zip in `~/tg-backups` and back it up by path to get background upload, pause and progress.
- The stored name carries a content fingerprint (`db.tgb-<hash>.zip`), so versions with the same name never mix. The app shows and restores the original name.
- An interrupted backup is listed as incomplete. Upload the same zip again to resume it.
- Backups uploaded by another machine appear after a backend restart, because the group is scanned once per connection.
- The backend only accepts requests from localhost, and in a browser only from the app's own page: other localhost ports are refused.
- Everything on disk is in `~/tg-backups` (`TGB_DATA_DIR` changes it). The Telegram session is in there, so treat it as a secret.

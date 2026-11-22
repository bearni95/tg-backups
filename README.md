# tg-backups

Create and restore zip backups using a Telegram group (tgb) as storage.

## Setup

1. Create a private Telegram group named `tgb` and copy its invite link.
2. `cp .env.example .env` and set `TGB_TELEGRAM_ACCESS_GROUP` to that link. Use the link, not the word `tgb`, which would resolve to a public username.
3. Get an API id and hash from https://my.telegram.org/apps and put them in `.env` or enter them in the app.
4. `pnpm install`

## Run

- Development: `pnpm dev:server` and, in another terminal, `pnpm dev`
- Built app: `pnpm start`, then open http://localhost:9811
- Rust tests: `pnpm test:rust`

## How it works

- Zips are split into 50 MiB MTProto chunks with metadata captions, up to 200 GiB per zip.
- Small zips can be picked in the browser. For large ones, put the zip in `~/tg-backups` and back it up by path to get background upload, pause and progress.
- The stored name carries a content fingerprint (`db.tgb-<hash>.zip`), so versions with the same name never mix. The app shows and restores the original name.
- An interrupted backup is listed as incomplete. Upload the same zip again to resume it.
- Backups uploaded by another machine appear after a backend restart, because the group is scanned once per connection.
- The backend only accepts requests from localhost.

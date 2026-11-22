# src/lib/server/telegram

The backup engine: zips stored in one Telegram group over MTProto, indexed in SQLite. The routes in `src/routes/api/telegram` are thin wrappers over it.

## Layout

| File                                  | Role                                                                 |
| ------------------------------------- | -------------------------------------------------------------------- |
| `storage.ts`                          | `TelegramStorage`: boot, credentials, logout, transfer, client swaps |
| `transport.ts`                        | The only wrapper around mtcute. The test seam                        |
| `connection.ts`                       | Per-client caches and the one automatic retry                        |
| `group.ts`                            | Membership probe and storage peer, from the access group spec        |
| `auth.ts`, `login.ts`                 | Code, QR and 2FA login, and the wizard's state                       |
| `status.ts`, `access-cookie.ts`       | The login gate and its signed one-hour bypass cookie                 |
| `upload.ts`, `uploads.ts`             | Chunked resumable upload, and the background queue (one at a time)   |
| `download.ts`, `restore.ts`           | Range restore from Telegram, and its HTTP response                   |
| `reconcile.ts`, `catalog.ts`          | Rebuild the index from the group, and list it                        |
| `files.ts`                            | `BackupFiles`: upload, restore, verify, delete                       |
| `browser-upload.ts`, `local-paths.ts` | The two ways in: multipart, or a path inside the data root           |
| `db.ts`, `session.ts`, `config.ts`    | What is on disk                                                      |

## Formats that must not change

Existing installs and existing groups depend on these.

- **Captions**: `tgb-multipart` JSON, sorted keys, always written as v2. The reader also takes v1.
- **Group id**: `sha256(stored name, NUL, size as u64 little-endian)`.
- **Stored name**: `<stem>.tgb-<12 hex of the content sha256>.zip`. Resume and reconcile match on (name, size), so never upload around `BackupFiles.uploadSource`, or versions will mix.
- **`<data root>/telegram/session.sqlite`**: JSON despite the name, in the grammers-session 0.9 layout. Access hashes are i64, so always use `parseJson` from `$utils/json/losslessJson`, never `JSON.parse`.
- **`credentials.json`**: `{ api_id, api_hash }`.
- **`index.sqlite`**: the schema in `db.ts`. Timestamps are RFC 3339 text with `+00:00`, sorted as text.

## Rules

- Every upload entry point checks `isAllowedBackup` (zip only, 415 otherwise).
- Use `transport.invoke`, never mtcute's `client.call` or its high-level methods: their `RpcError` replaces the number in `FLOOD_WAIT_7` and `FILE_MIGRATE_5` with `%d`.
- mtcute's middlewares stay off. Retry policy is `autoRetryDelayMs`, plus the part budget in `upload.ts`.
- The group is the only destination. Without `TGB_TELEGRAM_ACCESS_GROUP`, storage fails closed: no per-user group, no Saved Messages.
- Credentials priority: `credentials.json`, then environment, then build-time values.
- Chunks go in order (50 MiB each), with up to 8 parts of 512 KiB in flight.
- A resumed upload has a null full-file checksum, as does a reconciled one.
- Only complete backups restore. A short restore must error, never end cleanly.
- Message ids go to Telegram at most 100 per call. Re-fetch each chunk's message just before streaming, because file references expire.
- Never read an upload with `request.formData()`: it buffers the whole zip.
- Never log or echo credentials, codes, passwords or session contents, including through JSON parser error messages.
- Tests never reach Telegram: use `test/server/support/fake-telegram.ts`, and `test/server/transport.test.ts` for behaviour of mtcute itself.

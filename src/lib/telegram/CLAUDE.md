# src/lib/telegram

The backup engine: zips stored in Telegram groups over MTProto, with one SQLite index per group. The commands in `src/cli/commands` are thin wrappers over it.

## Layout

| File                                | Role                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| `storage.ts`                        | `TelegramStorage`: boot, credentials, logout, transfer, client swaps |
| `transport.ts`                      | The only wrapper around mtcute. The test seam                        |
| `connection.ts`                     | The account, the upload connections and the one automatic retry      |
| `groups.ts`, `group-registry.ts`    | Create, select and open groups, and `groups.json`                    |
| `group-admin.ts`                    | The Telegram calls behind that                                       |
| `backup-group.ts`                   | `BackupGroup`: peer, index and files of one group                    |
| `auth.ts`, `login.ts`               | Code, QR and 2FA login, and the state of one under way               |
| `status.ts`                         | What `tgb status` shows                                              |
| `upload.ts`, `uploads.ts`           | Chunked resumable upload, and the background queue (one at a time)   |
| `download.ts`, `restore.ts`         | Range restore from Telegram, and writing it to a file                |
| `reconcile.ts`, `catalog.ts`        | Rebuild the index from the group, and list it                        |
| `files.ts`                          | `BackupFiles`: upload, restore, verify, delete                       |
| `local-paths.ts`, `upload-paths.ts` | Uploads by path, and what a path may point at                        |
| `db.ts`, `session.ts`, `config.ts`  | What is on disk                                                      |
| `transfer.ts`                       | Reading a `tgb transfer export` file                                 |

## Formats that must not change

Existing installs and existing groups depend on these.

- **Captions**: `tgb-multipart` JSON, sorted keys, always written as v2. The reader also takes v1.
- **Group id**: `sha256(stored name, NUL, size as u64 little-endian)`.
- **Stored name**: `<stem>.tgb-<12 hex of the content sha256>.zip`. Resume and reconcile match on (name, size), so never upload around `BackupFiles.uploadSource`, or versions will mix.
- **`<data root>/telegram/session.sqlite`**: JSON despite the name, in the grammers-session 0.9 layout. Access hashes are i64, so always use `parseJson` from `$utils/json/losslessJson`, never `JSON.parse`.
- **`credentials.json`**: `{ api_id, api_hash }`.
- **`groups.json`**: groups and selection per account id.
- **`groups/<account id>/<group id>.sqlite`**: the schema in `db.ts`. Timestamps are RFC 3339 text with `+00:00`, sorted as text.

## Rules

- Every upload entry point checks `isAllowedBackup` (zip only, `unsupported_media_type` otherwise).
- Use `transport.invoke`, never mtcute's `client.call` or its high-level methods: their `RpcError` replaces the number in `FLOOD_WAIT_7` and `FILE_MIGRATE_5` with `%d`.
- mtcute's middlewares stay off. Retry policy is `autoRetryDelayMs`, plus the part budget in `upload.ts`.
- Groups come from `tgb groups`, never the environment. Without one, storage fails closed (`group_required`): no Saved Messages.
- Operations take a `BackupGroup` and keep it. Never read the selected group halfway through one.
- Created and newly selected groups have titles starting with `TGB-`, case-sensitive. Groups already in `groups.json` keep working without it, or their backups would be out of reach.
- Never share an index between groups or accounts: message ids repeat, so restores would return the wrong bytes.
- `channels.createChannel` is never retried automatically: that makes a second group.
- `delete-all` only works on a group named with `--group`, never the chosen one by default.
- Credentials priority: `credentials.json`, then environment, then build-time values.
- Chunks go in order (50 MiB each), with up to 8 parts of 512 KiB in flight.
- A resumed upload has a null full-file checksum, as does a reconciled one.
- A delete only forgets messages `deleteAndConfirm` saw gone. Never trust a delete call's own result: Telegram skips silently.
- A caller-chosen path is uploaded only through `uploadLocalFile(path, request, scope)`, which re-checks it as it opens. Any path may be named, except the app's own `telegram` folder. Files found in a folder carry `within`, so links out of that folder are never followed.
- Only complete backups restore. A short restore must error, never end cleanly, and `restoreToFile` only renames its `.part` file into place once every byte has arrived.
- Message ids go to Telegram at most 100 per call. Re-fetch each chunk's message just before streaming, because file references expire.
- Never log or echo credentials, codes, passwords or session contents, including through JSON parser error messages.
- Tests never reach Telegram: use `test/engine/support/fake-telegram.ts`, and `test/engine/transport.test.ts` for behaviour of mtcute itself.

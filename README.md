# tg-backups

A command line tool that creates and restores zip backups using Telegram groups as storage.

## Setup

1. With Node 24 or later: `pnpm install`, then `pnpm build`.
2. Put `tgb` on your path with `npm link` (pnpm 12 has no global link), or run it as `node dist/cli.js`. While developing, `pnpm tgb <command>` runs the source without building.
3. `tgb login`. It asks for an API id and hash from https://my.telegram.org/apps if none are saved yet. They can also go in `.env` (`cp .env.example .env`), or be set with `tgb credentials set`.
4. Choose where backups go: `tgb groups create <name>` makes a new group. To use one the account is already in, run `tgb groups available`, then `tgb groups use <id>`. Backup group names start with `TGB-`, in capitals: the tool adds it to the groups it creates, and only offers existing groups that have it.

## Menus

Run `tgb` with no command for an interactive tool. It signs you in if needed, then offers menus to:

- list, upload, restore and delete backups in the chosen group
- choose, create and share backup groups
- mark local files and folders for scheduled backup, choose how often each one runs, back them up now, and stop tracking them
- see your status and sign out

Arrow keys move, Enter picks, and Ctrl+C leaves. Every menu action is also a command (below), for scripts.

## Scheduled backups

Mark a file or folder with the menu, or with `tgb tracked add <path> --schedule <when>`. `<when>` is `hourly`, `daily` (03:00), `weekly` (Sunday 03:00), `monthly` (the 1st, 03:00), or any cron expression such as `"30 2 * * 1-5"`.

- tgb keeps a block of lines in your crontab, one per tracked path, and rewrites it whenever you add, reschedule or remove one. The rest of your crontab is left alone. `tgb tracked sync` rewrites it again, and `crontab -l` shows it.
- Each line runs `tgb tracked run <id>` with this machine's `node` and the built `dist/cli.js`, so run `pnpm build` first and again after updating. Output goes to `~/tg-backups/cron.log`.
- A `.zip` is uploaded as it is. Any other file, or a folder, is zipped first (`notes.txt` becomes `notes.txt.zip`). If nothing changed since the last backup, nothing is uploaded.
- **If a tracked path is missing when its backup is due**, tgb sends a message to its group with everything it knows about it: the path, whether it was a file or folder, why it couldn't be read, the machine, when it was checked, the schedule, when it was tracked, the last run and last backup (with its id), and its last known size and modification time.
- Runs take turns, so two jobs due in the same minute don't clash. Cron uses the credentials saved by `tgb login` (in `~/tg-backups`), not a `.env` file.

## Commands

| Command                                  | What it does                                                     |
| ---------------------------------------- | ---------------------------------------------------------------- |
| `tgb` or `tgb menu`                      | Interactive menus for all of the below                           |
| `tgb tracked [list]`                     | Tracked paths, their schedules and last runs                     |
| `tgb tracked add <path> [-s <when>]`     | Track a file or folder (default `daily`) and schedule it in cron |
| `tgb tracked schedule <id> <when>`       | Change how often a tracked path is backed up                     |
| `tgb tracked remove <ids...>`            | Stop tracking; backups already made stay                         |
| `tgb tracked run [ids...]`               | Back up tracked paths now (every one, without ids)               |
| `tgb tracked sync`                       | Rewrite tgb's crontab lines                                      |
| `tgb status`                             | Credentials, account and chosen group                            |
| `tgb login [--phone [number]]`           | Sign in by QR code, or by a code sent to a phone number          |
| `tgb logout`                             | Sign out, and wipe the session and local indexes                 |
| `tgb credentials set\|show\|clear`       | The API id and hash (`show` never prints the hash)               |
| `tgb groups [list]`                      | Groups this account uses; `*` marks the chosen one               |
| `tgb groups available`                   | Groups on the account that can be used                           |
| `tgb groups create <name>`               | Create a private group and choose it                             |
| `tgb groups use <group>`                 | Choose the group backups go to                                   |
| `tgb groups info [group]`                | Invite link, and warnings about settings that endanger backups   |
| `tgb groups share [group]`               | Invite link and QR code                                          |
| `tgb list`                               | Backups in the group                                             |
| `tgb upload <paths...> [--name <name>]`  | Back up zips, or folders of zips                                 |
| `tgb restore <id> [-o <file or folder>]` | Download a backup; `--force` overwrites                          |
| `tgb delete <ids...>`                    | Delete backups for every member of the group                     |
| `tgb delete-all --group <group>`         | Delete every message in a group (asks you to type its title)     |
| `tgb transfer export\|import`            | Move credentials, and optionally the session, to another machine |

- `--group <id or title>` picks the group for `list`, `upload`, `restore`, `delete` and `tracked add`. Without it, they use the chosen group.
- `--json` on `status`, `groups list`, `groups available`, `groups info`, `list` and `tracked list` prints JSON.
- `--yes` skips the confirmation on `delete`, `delete-all`, `tracked remove` and `credentials clear`.
- `--data-dir <path>` and `--verbose` go before the command: `tgb --verbose list`.
- `tgb <command> --help` shows every option.

While `upload` runs, `p` pauses and resumes it, and `c` or Ctrl+C cancels it. Uploads run one at a time.

## How it works

- Backups live in Telegram groups that you create or choose. You can have several and switch between them. An upload stays with the group it started in.
- Created groups are private, with history visible to new members and auto-delete off. Use `tgb groups share` to invite someone: every member can see and delete the backups.
- Groups are remembered per account. On another machine, sign in and run `tgb groups use`. A group without the `TGB-` prefix stays usable where it was already added, but has to be renamed in Telegram before it can be chosen anywhere else.
- Zips are split into 50 MiB MTProto chunks with metadata captions, up to 200 GiB per zip.
- `upload` takes any zip on the machine. Given a folder, it backs up every zip inside and follows links only while they stay in that folder. It never takes the tool's own `telegram` folder.
- The stored name carries a content fingerprint (`db.tgb-<hash>.zip`), so versions with the same name never mix. The tool shows and restores the original name.
- An interrupted or cancelled backup is listed as incomplete. Upload the same zip again to resume it: chunks already on Telegram are skipped.
- A restore writes to `<target>.part` and renames it only once every byte has arrived, so a cut-short restore never leaves a zip that looks finished.
- Each command reads the group once when it starts, so it sees backups uploaded from other machines.
- Run one `tgb` at a time per data folder: commands share the Telegram session and the index.
- Everything on disk is in `~/tg-backups` (`TGB_DATA_DIR` or `--data-dir` changes it). The Telegram session is in there, and so is any file from `tgb transfer export`: treat both as secrets.

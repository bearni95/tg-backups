# tg-backups

`tgb` is an interactive command line tool that stores zip backups in Telegram groups. Upload zips (or whole folders of them), restore them on any machine signed in to the same account, and back up local files and folders on a schedule with cron.

Run `tgb` on its own for menus, or use the commands below in scripts.

## Requirements

- Node.js 24 or later, and pnpm.
- A Telegram account, and an API id and hash for it from https://my.telegram.org/apps (under "API development tools").
- For scheduled backups: `cron` and the `crontab` command (Linux, macOS, WSL).

## Install

```sh
git clone <this repository> tg-backups
cd tg-backups
pnpm install
pnpm build      # writes dist/cli.js
npm link        # puts `tgb` on your PATH
```

Without `npm link`, run `node dist/cli.js` in place of `tgb`. After pulling updates, run `pnpm install` and `pnpm build` again: cron runs the built `dist/cli.js`.

## Getting started

1. **Sign in.** Run `tgb login`. If no API credentials are saved yet, it asks for the API id and hash first. Then it shows a QR code: in the Telegram app, open Settings > Devices > Link Desktop Device and scan it. To get a code by phone instead, run `tgb login --phone`. If the account has a two-step verification password, it asks for that too.
2. **Choose where backups go.** Run `tgb groups create <name>` to create a private group and choose it. To use a group the account is already in, run `tgb groups available`, then `tgb groups use <id>`. Backup group titles start with `TGB-` in capitals: `tgb` adds the prefix to the groups it creates, and only offers existing groups that already have it.
3. **Back something up.** `tgb upload ~/exports/photos.zip`, then `tgb list` to see it, and `tgb restore <id>` to get it back.

Or run `tgb` and do all of this from the menus.

## Menus

`tgb` with no command (or `tgb menu`) signs you in if needed, then shows the account and the chosen group, and offers:

- **Backups**: list, upload a zip or a folder of zips, restore, delete.
- **Scheduled backups of local files**: list tracked paths, mark a file or folder for backup, change how often it runs, back up now, stop tracking, and reinstall the cron jobs.
- **Groups**: list, choose, create, and show an invite link with a QR code.
- **Account**: show status, sign out.

Arrow keys move, Enter picks, and Ctrl+C leaves. Every menu action is also a command. The menus need a terminal: when stdin or stdout is not a TTY, `tgb` alone prints a note and exits with code 1.

## Commands

`tgb <command> --help` shows every option of a command.

### Account

| Command                      | What it does                                                            |
| ---------------------------- | ----------------------------------------------------------------------- |
| `tgb login`                  | Sign in by QR code. Asks for API credentials first if none are saved    |
| `tgb login --phone [number]` | Sign in with a code sent to the phone number (asked for if left out)    |
| `tgb logout`                 | Sign out, and wipe the session and the local indexes. Credentials stay  |
| `tgb status [--json]`        | Credentials, account, and the groups in use with the chosen one         |
| `tgb credentials set`        | Save an API id and hash. `--api-id` and `--api-hash` skip the questions |
| `tgb credentials show`       | Print the API id in use. The hash is never printed                      |
| `tgb credentials clear [-y]` | Forget the credentials and the session on this machine                  |

During a phone login, type `resend` at the code prompt to have the code sent another way, when Telegram offers one. Leave the password prompt empty to start the login over, for example after forgetting the two-step password.

### Groups

| Command                            | What it does                                                          |
| ---------------------------------- | --------------------------------------------------------------------- |
| `tgb groups [list] [--json]`       | Groups this account uses for backups. `*` marks the chosen one        |
| `tgb groups available [--json]`    | Groups on the account with a `TGB-` title that can be used            |
| `tgb groups create <name>`         | Create a private group titled `TGB-<name>` and choose it              |
| `tgb groups use <group>`           | Choose the group backups go to, by id or exact title                  |
| `tgb groups info [group] [--json]` | Title, invite link, and warnings about settings that endanger backups |
| `tgb groups share [group]`         | Print an invite link and its QR code                                  |

`<group>` is a group id (such as `channel-123456789`) or its exact title. Where it is optional, the chosen group is used.

### Backups

| Command                                  | What it does                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tgb list [--json]` (alias `ls`)         | Backups in the group: id, name, size, date, and whether complete                           |
| `tgb upload <paths...>` (alias `backup`) | Back up zip files, or every zip inside the given folders                                   |
| `tgb upload <zip> --name <name>`         | Store a single zip under another name                                                      |
| `tgb restore <id> [-o <path>] [-f]`      | Download a backup. `-o` is a file, or a folder to put it in (default `.`). `-f` overwrites |
| `tgb delete <ids...> [-y]` (alias `rm`)  | Delete backups from Telegram, for every member of the group                                |
| `tgb delete-all -g <group> [-y]`         | Delete every message in a group, backups or not                                            |

Each of these takes `-g, --group <group>` to work on a group other than the chosen one. `delete-all` requires it and never defaults to the chosen group; it asks you to type the group's title to confirm.

While an upload runs, a progress bar shows speed and time left. Press `p` to pause and resume, and `c` or Ctrl+C to cancel. Uploads run one at a time.

```sh
tgb upload ~/exports/2026-11.zip
tgb upload ~/exports                      # every zip in the folder
tgb list --group TGB-photos
tgb restore 3f2a… -o ~/restored/
tgb delete 3f2a… 9c1b… --yes
```

### Scheduled backups

| Command                                           | What it does                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `tgb tracked [list] [--json]`                     | Tracked paths, their schedules, groups and last runs               |
| `tgb tracked add <path> [-s <when>] [-g <group>]` | Track a file or folder (default `daily`) and add it to cron        |
| `tgb tracked schedule <id> <when>`                | Change how often a tracked path is backed up                       |
| `tgb tracked remove <ids...> [-y]` (alias `rm`)   | Stop tracking. Backups already made stay in the group              |
| `tgb tracked run [ids...]`                        | Back up tracked paths now, all of them without ids. Cron runs this |
| `tgb tracked sync`                                | Rewrite tgb's lines in the crontab from the tracked paths          |

`<when>` is one of:

| Value             | Runs                                      |
| ----------------- | ----------------------------------------- |
| `hourly`          | at minute 0 of every hour                 |
| `daily`           | every day at 03:00                        |
| `weekly`          | Sundays at 03:00                          |
| `monthly`         | the 1st of each month at 03:00            |
| a cron expression | for example `"30 2 * * 1-5"` or `@weekly` |

```sh
tgb tracked add ~/notes --schedule daily
tgb tracked add ~/db/app.sqlite -s "0 */6 * * *" -g TGB-servers
tgb tracked run          # back everything up now
crontab -l               # see the lines tgb installed
```

How it behaves:

- tgb keeps one block of lines in your crontab, one line per tracked path, and rewrites it whenever you add, reschedule or remove one. The rest of the crontab is left alone.
- Each line runs `tgb tracked run <id>` with this machine's `node` and the built `dist/cli.js`, so run `pnpm build` before tracking anything. Output goes to `~/tg-backups/cron.log`.
- A `.zip` is uploaded as it is. Any other file, and any folder, is zipped first (`notes.txt` becomes `notes.txt.zip`). If nothing changed since the last backup, nothing is uploaded.
- If a tracked path is missing when its backup is due, tgb posts a message to its group with what it knows: the path, whether it was a file or a folder, why it couldn't be read, the machine, the schedule, the last run and last backup, and its last known size and modification time.
- Runs take turns, so two jobs due in the same minute don't clash.
- Cron uses the credentials and session saved in the data folder, not a `.env` file.

### Moving to another machine

| Command                                                       | What it does                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `tgb transfer export [-o <file>] [--scope full\|credentials]` | Write the credentials, and with `full` (the default) the session, to a file or stdout |
| `tgb transfer import <file>`                                  | Take the credentials and session from that file                                       |

With the session, the transfer file signs anyone in to your Telegram account: keep it secret and delete it after importing. With `--scope credentials`, the new machine still has to run `tgb login`. Either way, run `tgb groups use <group>` there afterwards.

You can also skip the transfer: install `tgb` on the new machine, run `tgb login`, then `tgb groups use`.

## Using tgb in scripts

- Results go to stdout. Progress bars, prompts, notes and errors go to stderr, so stdout stays usable in a pipe.
- `--json` on `status`, `groups list`, `groups available`, `groups info`, `list` and `tracked list` prints JSON.
- `-y, --yes` skips the confirmation on `delete`, `delete-all`, `tracked remove` and `credentials clear`.
- Exit codes: `0` on success, `1` on an error (printed as `error: …`, with a hint when there is an obvious fix) or when an upload or tracked run fails, `130` when stopped with Ctrl+C.

```sh
tgb list --json | jq -r '.[] | select(.complete) | .id'
```

## Configuration

Global options go before the command, for example `tgb --verbose list`.

| Option              | Environment                            | What it does                                      |
| ------------------- | -------------------------------------- | ------------------------------------------------- |
| `--data-dir <path>` | `TGB_DATA_DIR`                         | Where everything is kept (default `~/tg-backups`) |
| `-v, --verbose`     | `TGB_VERBOSE=1`                        | Log what the engine is doing, to stderr           |
|                     | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | API credentials, if none are saved                |
| `--version`         |                                        | Print the version                                 |

`tgb` reads the nearest `.env` file, searching up from the current folder; real environment variables win. Copy `.env.example` to start one. Saved credentials (from `tgb login` or `tgb credentials set`) come first, then the environment, then any credentials present in the environment when `pnpm build` ran.

The data folder holds the credentials, the Telegram session, the chosen groups, a local index per group, the tracked paths and the cron log. The session signs anyone in to your account: treat the folder as a secret. Run one `tgb` at a time per data folder, since commands share the session and the index.

## How it works

- Backups live in Telegram groups you create or choose. You can have several and switch between them. An upload stays with the group it started in.
- Created groups are private, with history visible to new members and auto-delete off. `tgb groups info` warns when a group's settings would hide or delete backups. Anyone you invite with `tgb groups share` can see and delete the backups.
- Groups are remembered per account. A group without the `TGB-` prefix keeps working where it was already in use, but has to be renamed in Telegram before it can be chosen anywhere else.
- Only `.zip` files are stored. Zips are split into 50 MiB chunks with metadata captions, up to 200 GiB per zip.
- Given a folder, `upload` backs up every zip inside it and follows links only while they stay inside that folder. It never uploads tgb's own data.
- The stored name carries a content fingerprint (`db.tgb-<hash>.zip`), so versions with the same name never mix. `tgb` shows and restores the original name.
- An interrupted or cancelled upload is listed as incomplete. Upload the same zip again to resume it: chunks already on Telegram are skipped. Only complete backups can be restored.
- A restore writes to `<target>.part` and renames it once every byte has arrived, so a cut-short restore never leaves a zip that looks finished.
- Each command reads the group when it starts, so it sees backups uploaded from other machines.

## Development

```sh
pnpm tgb <command>   # run the CLI from source, without building
pnpm test            # run the tests (they never reach Telegram)
pnpm check           # type check
pnpm lint            # prettier and eslint
pnpm build           # bundle dist/cli.js
```

See `CLAUDE.md` for the project layout and conventions, and `src/lib/telegram/CLAUDE.md` for the formats that must not change.

import { Command } from 'commander';
import { APP_VERSION } from '$lib/build-info';
import { setVerbose } from '$lib/logger';
import { registerAuthCommands } from './commands/auth';
import { registerBackupCommands } from './commands/backups';
import { registerGroupCommands } from './commands/groups';
import { registerTrackedCommands } from './commands/tracked';
import { registerTransferCommands } from './commands/transfer';
import { withStorage } from './context';
import { runMenu } from './interactive';

/** Menus need someone at a keyboard; set by tests. */
let terminalCheck = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export function useTerminalCheck(check: (() => boolean) | undefined): void {
	terminalCheck = check ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY));
}

/** `throwOnExit` makes commander throw instead of exiting, for tests. */
export function createProgram({ throwOnExit = false } = {}): Command {
	const program = new Command('tgb');
	// Before the subcommands exist: they copy it when created.
	if (throwOnExit) program.exitOverride();
	program
		.description(
			'Create and restore zip backups using Telegram groups as storage. Run it without a command for menus.'
		)
		.version(APP_VERSION)
		.option('--data-dir <path>', 'where the session and indexes live (default ~/tg-backups)')
		.option('-v, --verbose', 'log what the engine is doing')
		.showHelpAfterError()
		.hook('preAction', (command) => {
			const options = command.opts<{ dataDir?: string; verbose?: boolean }>();
			if (options.verbose) setVerbose(true);
			if (options.dataDir) process.env.TGB_DATA_DIR = options.dataDir;
		});

	program
		.command('menu', { isDefault: true })
		.description('pick what to do from menus (what `tgb` alone does)')
		.action(() => {
			if (!terminalCheck()) {
				console.error('tgb: the menus need a terminal. Run `tgb --help` for the commands.');
				process.exitCode = 1;
				return;
			}
			return withStorage(runMenu);
		});

	registerAuthCommands(program);
	registerGroupCommands(program);
	registerBackupCommands(program);
	registerTrackedCommands(program);
	registerTransferCommands(program);
	return program;
}

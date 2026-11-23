import { Command } from 'commander';
import { APP_VERSION } from '$lib/build-info';
import { setVerbose } from '$lib/logger';
import { registerAuthCommands } from './commands/auth';
import { registerBackupCommands } from './commands/backups';
import { registerGroupCommands } from './commands/groups';
import { registerTransferCommands } from './commands/transfer';

/** `throwOnExit` makes commander throw instead of exiting, for tests. */
export function createProgram({ throwOnExit = false } = {}): Command {
	const program = new Command('tgb');
	// Before the subcommands exist: they copy it when created.
	if (throwOnExit) program.exitOverride();
	program
		.description('Create and restore zip backups using Telegram groups as storage.')
		.version(APP_VERSION)
		.option('--data-dir <path>', 'where the session and indexes live (default ~/tg-backups)')
		.option('-v, --verbose', 'log what the engine is doing')
		.showHelpAfterError()
		.hook('preAction', (command) => {
			const options = command.opts<{ dataDir?: string; verbose?: boolean }>();
			if (options.verbose) setVerbose(true);
			if (options.dataDir) process.env.TGB_DATA_DIR = options.dataDir;
		});

	registerAuthCommands(program);
	registerGroupCommands(program);
	registerBackupCommands(program);
	registerTransferCommands(program);
	return program;
}

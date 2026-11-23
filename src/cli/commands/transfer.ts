// Moving the setup to another machine.
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { StorageError } from '$lib/telegram/errors';
import { writePrivateFile } from '$lib/telegram/session';
import { parseTransfer } from '$lib/telegram/transfer';
import { withStorage } from '../context';

export function registerTransferCommands(program: Command): void {
	const transfer = program
		.command('transfer')
		.description('move the credentials, and optionally the session, to another machine');

	transfer
		.command('export')
		.description('write a transfer file; with the session it signs anyone in, so keep it secret')
		.option('--scope <scope>', '`full` (with the session) or `credentials`', 'full')
		.option('-o, --output <file>', 'file to write; stdout when left out')
		.action((options: { scope: string; output?: string }) =>
			withStorage(async (storage) => {
				const text = JSON.stringify(await storage.exportTransfer(options.scope));
				if (!options.output) {
					console.log(text);
					return;
				}
				writePrivateFile(options.output, text);
				console.error(`Wrote ${options.output}. It is readable by you only.`);
			})
		);

	transfer
		.command('import')
		.argument('<file>', 'a file from `tgb transfer export`')
		.description('take credentials and session from a transfer file')
		.action((file: string) =>
			withStorage(async (storage) => {
				let text: string;
				try {
					text = await readFile(file, 'utf8');
				} catch (error) {
					throw StorageError.badRequest(`cannot read ${file}: ${(error as Error).message}`);
				}
				await storage.importTransfer(parseTransfer(text));
				console.log('Imported. Run `tgb status` to check.');
			})
		);
}

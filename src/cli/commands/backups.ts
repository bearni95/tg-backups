// Listing, uploading, restoring and deleting backups.
import { resolve } from 'node:path';
import { confirm, input } from '@inquirer/prompts';
import type { Command } from 'commander';
import { listFiles } from '$lib/telegram/catalog';
import { StorageError } from '$lib/telegram/errors';
import { startUpload } from '$lib/telegram/local-paths';
import { restoreToFile } from '$lib/telegram/restore';
import { cliDisplayAdapter } from '$adapters/classes/cli-display.adapter';
import type { TelegramUploadSnapshot } from '$types/telegram.type';
import { printJson, resolveGroup, withStorage } from '../context';
import { restoreBar, watchUploads } from '../progress';

const GROUP_OPTION = [
	'-g, --group <group>',
	'group id or title; the chosen one by default'
] as const;

export function registerBackupCommands(program: Command): void {
	program
		.command('list')
		.alias('ls')
		.description('list the backups in a group')
		.option(...GROUP_OPTION)
		.option('--json', 'print JSON')
		.action((options: { group?: string; json?: boolean }) =>
			withStorage(async (storage) => {
				const group = await resolveGroup(storage, options.group);
				const files = await listFiles(group, null);
				if (options.json) return printJson(files);
				console.log(cliDisplayAdapter.filesTable(files));
			})
		);

	program
		.command('upload')
		.alias('backup')
		.argument('<paths...>', 'zip files, or folders of zips')
		.description('back up zips; an interrupted upload resumes when run again')
		.option(...GROUP_OPTION)
		.option('--name <name>', 'store a single zip under this name')
		.action((paths: string[], options: { group?: string; name?: string }) =>
			withStorage(async (storage) => {
				if (options.name !== undefined && paths.length > 1) {
					throw StorageError.badRequest('--name works with a single zip only');
				}
				const group = await resolveGroup(storage, options.group);
				const queued: TelegramUploadSnapshot[] = [];
				try {
					for (const path of paths) {
						queued.push(
							...(await startUpload(storage, group, { path: resolve(path), name: options.name }))
						);
					}
				} catch (error) {
					// All or nothing: a bad path doesn't leave the others running.
					for (const upload of queued) storage.uploads.cancel(upload.uploadId);
					throw error;
				}

				console.error(`Uploading ${queued.length} zip(s) to ${group.title}.`);
				const results = await watchUploads(
					storage.uploads,
					queued.map((upload) => upload.uploadId)
				);
				for (const upload of results) {
					if (upload.status === 'completed') console.log(`${upload.fileId}  ${upload.name}`);
					else
						console.error(
							`${upload.status}: ${upload.name}${upload.error ? `: ${upload.error}` : ''}`
						);
				}
				if (results.some((upload) => upload.status === 'cancelled')) {
					console.error('Run the same command again to resume: chunks already sent are skipped.');
				}
				if (results.some((upload) => upload.status !== 'completed')) process.exitCode = 1;
			})
		);

	program
		.command('restore')
		.argument('<id>', 'backup id, from `tgb list`')
		.description('download a backup to a file or folder')
		.option(...GROUP_OPTION)
		.option('-o, --output <path>', 'file, or folder to put it in under its name', '.')
		.option('-f, --force', 'overwrite an existing file')
		.action((id: string, options: { group?: string; output: string; force?: boolean }) =>
			withStorage(async (storage) => {
				const group = await resolveGroup(storage, options.group);
				// Fills the index, so a backup another machine uploaded is found.
				await listFiles(group, null);
				const bar = restoreBar(id);
				try {
					const path = await restoreToFile(group, id, {
						target: resolve(options.output),
						overwrite: options.force,
						onProgress: (written, total) => bar?.update(written, total)
					});
					bar?.stop();
					console.log(path);
				} catch (error) {
					bar?.stop();
					throw error;
				}
			})
		);

	program
		.command('delete')
		.alias('rm')
		.argument('<ids...>', 'backup ids, from `tgb list`')
		.description('delete backups from Telegram')
		.option(...GROUP_OPTION)
		.option('-y, --yes', 'do not ask for confirmation')
		.action((ids: string[], options: { group?: string; yes?: boolean }) =>
			withStorage(async (storage) => {
				const group = await resolveGroup(storage, options.group);
				const files = await listFiles(group, null);
				const chosen = ids.map((id) => {
					const file = files.find((entry) => entry.id === id);
					if (!file) throw StorageError.badRequest(`no backup ${id} in ${group.title}`);
					return file;
				});
				if (!options.yes) {
					console.log(cliDisplayAdapter.filesTable(chosen));
					const sure = await confirm({
						message: `Delete ${chosen.length === 1 ? 'this backup' : `these ${chosen.length} backups`} for every member of ${group.title}?`,
						default: false
					});
					if (!sure) return;
				}
				for (const file of chosen) {
					await group.files.delete(file.id);
					console.log(`deleted ${file.id}  ${file.name}`);
				}
			})
		);

	program
		.command('delete-all')
		.description('delete every message in a group, backups or not')
		.requiredOption('-g, --group <group>', 'group id or title; never defaults to the chosen one')
		.option('-y, --yes', 'do not ask for confirmation')
		.action((options: { group: string; yes?: boolean }) =>
			withStorage(async (storage) => {
				const group = await resolveGroup(storage, options.group);
				if (!options.yes) {
					const typed = await input({
						message: `This deletes every message in ${group.title}. Type its title to confirm`
					});
					if (typed !== group.title) {
						console.log('Title did not match. Nothing deleted.');
						return;
					}
				}
				console.log(`Deleted ${await group.files.deleteAll()} message(s).`);
			})
		);
}

// The Telegram groups backups are stored in.
import type { Command } from 'commander';
import { cliDisplayAdapter } from '$adapters/classes/cli-display.adapter';
import { printJson, resolveGroup, withStorage } from '../context';
import { terminalQr } from '../qr';

export function registerGroupCommands(program: Command): void {
	const groups = program.command('groups').description('the Telegram groups backups are stored in');

	groups
		.command('list', { isDefault: true })
		.description('the groups this account uses; * marks the chosen one')
		.option('--json', 'print JSON')
		.action((options: { json?: boolean }) =>
			withStorage(async (storage) => {
				await storage.requireAuthorized();
				const overview = storage.groups.overview(await storage.requireClient().account());
				if (options.json) return printJson(overview);
				console.log(cliDisplayAdapter.groupsTable(overview.groups, overview.activeGroupId));
			})
		);

	groups
		.command('available')
		.description('groups on this account that can be used (titles starting with TGB-)')
		.option('--json', 'print JSON')
		.action((options: { json?: boolean }) =>
			withStorage(async (storage) => {
				await storage.requireAuthorized();
				const available = await storage.groups.available();
				if (options.json) return printJson(available);
				if (available.length === 0) {
					console.log(
						'No group this account can send files to has a title starting with TGB- (in capitals). Create one, or rename one in Telegram.'
					);
					return;
				}
				console.log(cliDisplayAdapter.groupsTable(available));
			})
		);

	groups
		.command('create')
		.argument('<name>', 'group name; TGB- is added in front')
		.description('create a private Telegram group and choose it')
		.action((name: string) =>
			withStorage(async (storage) => {
				await storage.requireAuthorized();
				const group = await storage.groups.create(name);
				console.log(`Created and chose ${group.title} (${group.id}).`);
			})
		);

	groups
		.command('use')
		.argument('<group>', 'group id, or exact title')
		.description('choose the group backups go to: one in use, or one from `groups available`')
		.action((name: string) =>
			withStorage(async (storage) => {
				await storage.requireAuthorized();
				const userId = await storage.requireClient().account();
				const known = storage.groups.overview(userId).groups;
				const candidates = known.some((group) => group.id === name || group.title === name)
					? known
					: await storage.groups.available();
				const matches = candidates.filter((group) => group.id === name || group.title === name);
				if (matches.length > 1) {
					throw new Error(`several groups are titled ${name}: name one by id`);
				}
				const group = await storage.groups.select(matches[0]?.id ?? name);
				console.log(`Backups now go to ${group.title} (${group.id}).`);
			})
		);

	groups
		.command('info')
		.argument('[group]', 'group id or title; the chosen one by default')
		.description('show a group, with warnings about settings that endanger backups')
		.option('--json', 'print JSON')
		.action((name: string | undefined, options: { json?: boolean }) =>
			withStorage(async (storage) => {
				const { id } = await resolveGroup(storage, name);
				const info = await storage.groups.info(id);
				if (options.json) return printJson(info);
				console.log(`${info.title} (${info.id})`);
				console.log(`invite  ${info.invite ?? 'this account cannot share it'}`);
				for (const warning of cliDisplayAdapter.groupWarnings(info)) {
					console.log(`\nwarning: ${warning}`);
				}
			})
		);

	groups
		.command('share')
		.argument('[group]', 'group id or title; the chosen one by default')
		.description('print an invite link and QR code: members can see and delete its backups')
		.action((name: string | undefined) =>
			withStorage(async (storage) => {
				const { id } = await resolveGroup(storage, name);
				const info = await storage.groups.info(id);
				if (!info.invite) throw new Error('this account cannot share an invite to this group');
				console.log(terminalQr(info.invite));
				console.log(info.invite);
				console.log('Anyone with this link can join, then see and delete its backups.');
			})
		);
}

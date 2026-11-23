// Credentials, sign-in and sign-out.
import { confirm, input, password } from '@inquirer/prompts';
import type { Command } from 'commander';
import logUpdate from 'log-update';
import { sleep } from '$lib/sync';
import { StorageError } from '$lib/telegram/errors';
import { readStatus } from '$lib/telegram/status';
import type { TelegramStorage } from '$lib/telegram/storage';
import { cliDisplayAdapter } from '$adapters/classes/cli-display.adapter';
import { codeMethodLabel, describeCodeDelivery } from '$utils/telegram/codeDelivery';
import type { TelegramAuthOutcome, TelegramCodeDelivery } from '$types/telegram.type';
import { printJson, withStorage } from '../context';
import { terminalQr } from '../qr';

const QR_POLL_MS = 3000;

function parseApiId(raw: string): number {
	const value = Number(raw.trim());
	if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value <= 0 || value >= 2 ** 31) {
		throw StorageError.badRequest('api id must be a positive whole number');
	}
	return value;
}

async function askCredentials(storage: TelegramStorage, apiId?: string, apiHash?: string) {
	if (apiId === undefined || apiHash === undefined) {
		console.log('Get an API id and hash at https://my.telegram.org/apps');
	}
	const id =
		apiId ??
		(await input({
			message: 'API id',
			validate: (value) => {
				try {
					parseApiId(value);
					return true;
				} catch (error) {
					return (error as Error).message;
				}
			}
		}));
	const hash =
		apiHash ??
		(await password({ message: 'API hash', mask: '*', validate: (value) => value.trim() !== '' }));
	await storage.setCredentials({ apiId: parseApiId(id), apiHash: hash.trim() });
	console.log('Credentials saved.');
}

function signedIn(outcome: Extract<TelegramAuthOutcome, { outcome: 'authenticated' }>): void {
	console.log(`Signed in as ${cliDisplayAdapter.userName(outcome.user)}.`);
}

/** Asks until the password is right. Empty input offers to start the login over. */
async function askPassword(storage: TelegramStorage, hint: string | null): Promise<boolean> {
	for (;;) {
		const entered = await password({
			message: `Two-step verification password${hint ? ` (hint: ${hint})` : ''}`,
			mask: '*'
		});
		if (entered === '') {
			if (await confirm({ message: 'Forgot it? Start the login over?', default: false })) {
				await storage.restartLogin();
				console.log('Login dropped. Run `tgb login` to start again.');
				return false;
			}
			continue;
		}
		try {
			const outcome = await storage.login.submitPassword(entered);
			if (outcome.outcome === 'authenticated') signedIn(outcome);
			return true;
		} catch (error) {
			if (StorageError.from(error).code !== 'invalid_password') throw error;
			console.error('Wrong password, try again.');
		}
	}
}

async function finish(storage: TelegramStorage, outcome: TelegramAuthOutcome): Promise<boolean> {
	if (outcome.outcome === 'authenticated') {
		signedIn(outcome);
		return true;
	}
	return askPassword(storage, outcome.hint);
}

async function phoneLogin(storage: TelegramStorage, phone: string): Promise<boolean> {
	let delivery: TelegramCodeDelivery = await storage.login.start(phone);
	for (;;) {
		console.log(describeCodeDelivery(delivery));
		const resend = delivery.nextMethod
			? ` (or "resend" for ${codeMethodLabel(delivery.nextMethod)})`
			: '';
		const code = (await input({ message: `Code${resend}` })).trim();
		if (code === '') continue;
		if (code === 'resend' && delivery.nextMethod) {
			delivery = await storage.login.resend();
			continue;
		}
		try {
			return await finish(storage, await storage.login.submitCode(code));
		} catch (error) {
			if (StorageError.from(error).code !== 'invalid_code') throw error;
			console.error('Wrong code, try again.');
		}
	}
}

/** Polls the QR login, redrawing the code whenever Telegram issues a new token. */
async function qrLogin(storage: TelegramStorage): Promise<boolean> {
	let stopped = false;
	const stop = () => (stopped = true);
	process.once('SIGINT', stop);
	try {
		let shown = '';
		while (!stopped) {
			const step = await storage.login.qrStep();
			if (step.outcome !== 'pending') {
				logUpdate.clear();
				return await finish(storage, step);
			}
			if (step.url !== shown) {
				shown = step.url;
				logUpdate(
					`${terminalQr(step.url)}\nScan with Telegram: Settings > Devices > Link Desktop Device.\nPress Ctrl+C to stop, or use \`tgb login --phone\` instead.`
				);
			}
			await sleep(QR_POLL_MS);
		}
		logUpdate.clear();
		process.exitCode = 130;
		return false;
	} finally {
		process.off('SIGINT', stop);
	}
}

export function registerAuthCommands(program: Command): void {
	const credentials = program
		.command('credentials')
		.description('the Telegram API id and hash this app signs in with');

	credentials
		.command('set')
		.description('save an API id and hash (asks for whatever is left out)')
		.option('--api-id <id>', 'API id from my.telegram.org')
		.option('--api-hash <hash>', 'API hash from my.telegram.org')
		.action((options: { apiId?: string; apiHash?: string }) =>
			withStorage((storage) => askCredentials(storage, options.apiId, options.apiHash))
		);

	credentials
		.command('show')
		.description('show the API id in use (never the hash)')
		.action(() =>
			withStorage(async (storage) => {
				if (!storage.credentials) throw StorageError.credentialsMissing();
				console.log(`api_id ${storage.credentials.apiId}`);
			})
		);

	credentials
		.command('clear')
		.description('forget the credentials, and sign out of this machine')
		.option('-y, --yes', 'do not ask for confirmation')
		.action((options: { yes?: boolean }) =>
			withStorage(async (storage) => {
				const sure =
					options.yes ||
					(await confirm({
						message: 'Forget the credentials and the Telegram session on this machine?',
						default: false
					}));
				if (!sure) return;
				await storage.deleteCredentials();
				console.log('Credentials and session removed.');
			})
		);

	program
		.command('login')
		.description('sign in to Telegram, by QR code unless --phone is given')
		.option('--phone [number]', 'sign in with a code sent to this phone number')
		.action((options: { phone?: string | boolean }) =>
			withStorage(async (storage) => {
				if (!storage.credentials) await askCredentials(storage);
				const before = await readStatus(storage);
				if (before.authorized) {
					console.log(
						`Already signed in${before.user ? ` as ${cliDisplayAdapter.userName(before.user)}` : ''}.`
					);
					return;
				}

				const done =
					options.phone === undefined
						? await qrLogin(storage)
						: await phoneLogin(
								storage,
								typeof options.phone === 'string'
									? options.phone
									: await input({ message: 'Phone number, with country code' })
							);
				if (!done) return;

				const after = await readStatus(storage);
				if (!after.activeGroupId) {
					console.log(
						'Next, choose where backups go: `tgb groups create <name>`, or `tgb groups available` then `tgb groups use <id>`.'
					);
				}
			})
		);

	program
		.command('logout')
		.description('sign out, and wipe the session and local indexes')
		.action(() =>
			withStorage(async (storage) => {
				await storage.logout();
				console.log('Signed out.');
			})
		);

	program
		.command('status')
		.description('show the credentials, account and chosen group')
		.option('--json', 'print JSON')
		.action((options: { json?: boolean }) =>
			withStorage(async (storage) => {
				const status = await readStatus(storage);
				if (options.json) return printJson(status);
				const lines = cliDisplayAdapter.statusLines(status, storage.credentials?.apiId ?? null);
				console.log(lines.join('\n'));
			})
		);
}

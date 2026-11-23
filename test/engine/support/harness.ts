import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { useTransport } from '../../../src/cli/context';
import { createProgram } from '../../../src/cli/program';
import { saveCredentials } from '../../../src/lib/telegram/config';
import { groupsPath, telegramDir } from '../../../src/lib/telegram/paths';
import { TelegramStorage } from '../../../src/lib/telegram/storage';
import type { TelegramUploadSnapshot } from '../../../src/types/telegram.type';
import { CHANNEL_ID, FakeTelegram, USER_ID } from './fake-telegram';

/** A temporary data root and a fake Telegram per test. Never the real `~/tg-backups`. */
export function useBackend() {
	let root = '';
	let telegram: FakeTelegram;
	let opened: TelegramStorage[] = [];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'tgb-test-'));
		telegram = new FakeTelegram();
		opened = [];
		vi.stubEnv('TELEGRAM_API_ID', '');
		vi.stubEnv('TELEGRAM_API_HASH', '');
		vi.stubEnv('TGB_DATA_DIR', root);
		// Never the real crontab.
		vi.stubEnv('TGB_CRONTAB_FILE', join(root, 'crontab'));
	});

	afterEach(async () => {
		for (const storage of opened) await storage.close().catch(() => undefined);
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	const open = async (dataRoot = root) => {
		const storage = await TelegramStorage.init({ dataRoot, createTransport: telegram.factory });
		opened.push(storage);
		return storage;
	};

	/** Credentials saved, and the fake's main group chosen, as an earlier run would leave them. */
	const seed = async (dataRoot = root, { group = true } = {}) => {
		await saveCredentials(dataRoot, { apiId: 12345, apiHash: 'deadbeef' });
		if (!group) return;
		const kind = telegram.basicGroup ? 'chat' : 'channel';
		const id = `${kind}-${CHANNEL_ID}`;
		const accessHash = telegram.basicGroup ? '0' : '8123456789012345678';
		const account = { activeGroupId: id, groups: [{ id, title: 'TGB-main', accessHash }] };
		mkdirSync(telegramDir(dataRoot), { recursive: true });
		writeFileSync(groupsPath(dataRoot), JSON.stringify({ v: 1, accounts: { [USER_ID]: account } }));
	};

	/** With credentials saved, so there is a client, and no group yet. */
	const withoutGroup = async (dataRoot = root) => {
		await seed(dataRoot, { group: false });
		return open(dataRoot);
	};

	const signedIn = async (dataRoot = root) => {
		await seed(dataRoot);
		return open(dataRoot);
	};

	return {
		get root() {
			return root;
		},
		get telegram() {
			return telegram;
		},
		open,
		seed,
		withoutGroup,
		signedIn,
		/** That group, opened. */
		async group(dataRoot = root) {
			return (await signedIn(dataRoot)).groups.resolve(null);
		},
		/** Run `tgb …` against the fake Telegram, on the test's data root. */
		async tgb(...args: string[]) {
			const log = vi.mocked(console.log);
			const error = vi.mocked(console.error);
			log.mockClear();
			error.mockClear();
			process.exitCode = undefined;
			useTransport(telegram.factory);
			try {
				await createProgram({ throwOnExit: true }).parseAsync(args, { from: 'user' });
			} catch (error) {
				// Commander's own refusals, like a missing required option.
				if (!(error instanceof CommanderError)) throw error;
				process.exitCode = error.exitCode;
			} finally {
				useTransport(undefined);
			}
			const code = Number(process.exitCode ?? 0);
			process.exitCode = undefined;
			const text = (calls: unknown[][]) => calls.map((call) => call.join(' ')).join('\n');
			return { code, stdout: text(log.mock.calls), stderr: text(error.mock.calls) };
		}
	};
}

/** Waits for a queued upload to end, and returns its last snapshot. */
export async function settledUpload(
	storage: TelegramStorage,
	id: string
): Promise<TelegramUploadSnapshot> {
	await vi.waitFor(() => expect(storage.uploads.get(id)?.finishedAt).not.toBeNull());
	return storage.uploads.get(id)!;
}

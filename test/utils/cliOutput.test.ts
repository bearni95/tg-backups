// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cliDisplayAdapter } from '../../src/adapters/classes/cli-display.adapter';
import { formatTable } from '../../src/utils/table';
import { uploadProgress } from '../../src/utils/telegram/uploadProgress';
import type { TelegramUploadSnapshot } from '../../src/types/telegram.type';

function snapshot(overrides: Partial<TelegramUploadSnapshot> = {}): TelegramUploadSnapshot {
	return {
		uploadId: 'u',
		refId: 'r',
		groupId: 'g',
		groupTitle: 'TGB-g',
		name: 'db.zip',
		status: 'running',
		bytesUploaded: 0,
		skippedBytes: 0,
		totalBytes: 1000,
		chunksCompleted: 0,
		totalChunks: 1,
		fileId: null,
		error: null,
		startedAt: 0,
		transferStartedAt: 100,
		finishedAt: null,
		chunks: [],
		...overrides
	};
}

describe('uploadProgress', () => {
	it('is queued until the transfer starts', () => {
		expect(uploadProgress(snapshot({ transferStartedAt: null }), 200)).toEqual({
			percent: 0,
			queued: true,
			bytesPerSecond: 0,
			etaSeconds: null
		});
	});

	it('averages speed over the whole transfer', () => {
		const view = uploadProgress(snapshot({ bytesUploaded: 500 }), 110);
		expect(view).toMatchObject({ percent: 50, queued: false, bytesPerSecond: 50, etaSeconds: 10 });
	});

	it('leaves skipped chunks out of the speed', () => {
		const view = uploadProgress(snapshot({ bytesUploaded: 600, skippedBytes: 500 }), 110);
		expect(view).toMatchObject({ percent: 60, bytesPerSecond: 10, etaSeconds: 40 });
	});

	it('stops the clock when finished', () => {
		const done = snapshot({ status: 'completed', bytesUploaded: 1000, finishedAt: 120 });
		expect(uploadProgress(done, 999)).toMatchObject({ bytesPerSecond: 50, etaSeconds: null });
	});
});

describe('formatTable', () => {
	it('pads every column but the last', () => {
		expect(
			formatTable([
				['ID', 'NAME'],
				['a-long-id', 'x'],
				['b', 'y y']
			])
		).toBe('ID         NAME\na-long-id  x\nb          y y');
	});
});

describe('cliDisplayAdapter', () => {
	it('names a user', () => {
		const user = { id: 1, firstName: 'Ada', lastName: null, username: 'ada', phone: null };
		expect(cliDisplayAdapter.userName(user)).toBe('Ada @ada');
		expect(cliDisplayAdapter.userName({ ...user, firstName: null, username: null })).toBe('user 1');
	});

	it('marks incomplete backups', () => {
		const table = cliDisplayAdapter.filesTable([
			{
				id: 'f1',
				name: 'db.zip',
				sizeBytes: 2048,
				complete: false,
				mimeType: 'application/zip',
				createdAt: 'not a date'
			}
		]);
		expect(table).toContain('incomplete');
		expect(table).toContain('2.00 KB');
		expect(table).toContain('not a date');
	});

	it('warns about auto-delete and hidden history', () => {
		const warnings = cliDisplayAdapter.groupWarnings({
			id: 'g',
			title: 'TGB-g',
			invite: null,
			autoDeleteSeconds: 86400,
			historyHidden: true
		});
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain('24h 0m');
	});
});

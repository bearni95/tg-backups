import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { telegramService, TelegramApiError } from '../../src/services/telegram.service';

const okJson = (body: unknown) => ({
	ok: true,
	status: 200,
	json: async () => body
});

const okNoContent = () => ({
	ok: true,
	status: 204,
	json: async () => {
		throw new Error('no body');
	}
});

const errJson = (status: number, body: unknown) => ({
	ok: false,
	status,
	json: async () => body
});

const errBadJson = (status: number) => ({
	ok: false,
	status,
	statusText: 'Bad',
	json: async () => {
		throw new Error('bad');
	}
});

const GROUP = 'channel-1';
const inGroup = (id: string | null = GROUP) => ({
	authorized: true,
	groups: id ? [{ id, title: 'One' }] : [],
	activeGroupId: id
});

describe('telegramService', () => {
	beforeEach(() => {
		telegramService.stop();
		telegramService.status.set(null);
		telegramService.files.set([]);
		telegramService.uploads.set([]);
		telegramService.loadingStatus.set(false);
		telegramService.loadingFiles.set(false);
		telegramService.lastError.set(null);
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	afterEach(() => {
		telegramService.stop();
	});

	describe('start/stop polling', () => {
		it('start schedules a 5s status poll; stop cancels it', async () => {
			vi.useFakeTimers();
			const fetchMock = vi.fn().mockResolvedValue(okJson({ state: 'idle' }));
			vi.stubGlobal('fetch', fetchMock);

			telegramService.start();
			// Initial poll triggers immediately
			await Promise.resolve();
			expect(fetchMock).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(5000);
			expect(fetchMock).toHaveBeenCalledTimes(2);

			telegramService.stop();
			await vi.advanceTimersByTimeAsync(5000);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('start is idempotent', async () => {
			const fetchMock = vi.fn().mockResolvedValue(okJson({ state: 'idle' }));
			vi.stubGlobal('fetch', fetchMock);
			telegramService.start();
			telegramService.start();
			await Promise.resolve();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			telegramService.stop();
		});
	});

	describe('TelegramApiError', () => {
		it('captures message, code, status, retry, and limit', () => {
			const err = new TelegramApiError(429, {
				error: 'rate-limited',
				code: 'rl',
				retryAfterSeconds: 5,
				limitBytes: 100
			});
			expect(err.message).toBe('rate-limited');
			expect(err.code).toBe('rl');
			expect(err.status).toBe(429);
			expect(err.retryAfterSeconds).toBe(5);
			expect(err.limitBytes).toBe(100);
			expect(err.name).toBe('TelegramApiError');
		});

		it('falls back to a default message and code when missing', () => {
			const err = new TelegramApiError(500, {});
			expect(err.message).toContain('500');
			expect(err.code).toBe('unknown');
		});
	});

	describe('refreshStatus', () => {
		it('captures error on bad JSON body', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errBadJson(500)));
			await telegramService.refreshStatus();
			expect(get(telegramService.lastError)).toBe('Bad');
		});

		it('captures non-Error throws', async () => {
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue('boom'));
			await telegramService.refreshStatus();
			expect(get(telegramService.lastError)).toBe('boom');
		});
	});

	describe('credentials', () => {
		it('returns null when credentials_missing', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue(errJson(404, { code: 'credentials_missing' }))
			);
			const c = await telegramService.getCredentials();
			expect(c).toBeNull();
		});

		it('returns body on success', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ apiId: 1, apiHash: 'h' })));
			const c = await telegramService.getCredentials();
			expect(c).toEqual({ apiId: 1, apiHash: 'h' });
		});

		it('rethrows non-credentials_missing errors', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errJson(500, { code: 'other' })));
			await expect(telegramService.getCredentials()).rejects.toBeInstanceOf(TelegramApiError);
			expect(get(telegramService.lastError)).toBeTruthy();
		});

		it('setCredentials POSTs and refreshes status', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okNoContent())
				.mockResolvedValueOnce(okJson({ state: 'ok' }));
			vi.stubGlobal('fetch', fetchMock);
			await telegramService.setCredentials(1, 'h');
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
		});

		it('deleteCredentials DELETEs, clears files, refreshes status', async () => {
			telegramService.files.set([{ id: 'a', name: 'x' }] as never);
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okNoContent()));
			await telegramService.deleteCredentials();
			expect(get(telegramService.files)).toEqual([]);
		});
	});

	describe('qr login', () => {
		afterEach(() => {
			telegramService.stopQrLogin();
			vi.useRealTimers();
		});

		it('shows the pending QR and keeps polling until authenticated', async () => {
			vi.useFakeTimers();
			const pending = { outcome: 'pending', url: 'tg://login?token=abc', expiresAt: 1 };
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okJson(pending))
				.mockResolvedValueOnce(okJson({ outcome: 'authenticated', user: { id: 1 } }))
				.mockResolvedValueOnce(okJson(inGroup()))
				.mockResolvedValueOnce(okJson({ files: [] }));
			vi.stubGlobal('fetch', fetchMock);

			telegramService.startQrLogin();
			await vi.advanceTimersByTimeAsync(0);
			expect(fetchMock.mock.calls[0][0]).toBe('/api/telegram/auth/qr');
			expect(get(telegramService.qrLogin)).toEqual(pending);

			await vi.advanceTimersByTimeAsync(3000);
			expect(get(telegramService.qrLogin)).toBeNull();
			expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
				'/api/telegram/auth/qr',
				'/api/telegram/auth/qr',
				'/api/telegram/status',
				'/api/telegram/files?group=channel-1'
			]);
		});

		it('stops polling and surfaces the error when a poll fails', async () => {
			vi.stubGlobal(
				'fetch',
				vi.fn().mockResolvedValue(errJson(500, { error: 'boom', code: 'telegram' }))
			);
			telegramService.startQrLogin();
			await vi.waitFor(() => expect(get(telegramService.lastError)).toBe('boom'));
			expect(get(telegramService.qrLogin)).toBeNull();
		});

		it('stopQrLogin cancels the next poll', async () => {
			vi.useFakeTimers();
			const fetchMock = vi
				.fn()
				.mockResolvedValue(okJson({ outcome: 'pending', url: 'tg://login?token=x', expiresAt: 1 }));
			vi.stubGlobal('fetch', fetchMock);
			telegramService.startQrLogin();
			await vi.advanceTimersByTimeAsync(0);
			telegramService.stopQrLogin();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('auth flow', () => {
		it('startAuth POSTs', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okNoContent())
				.mockResolvedValueOnce(okJson({ state: 'awaiting_code' }));
			vi.stubGlobal('fetch', fetchMock);
			await telegramService.startAuth('+1');
			expect(fetchMock.mock.calls[0][0]).toBe('/api/telegram/auth/start');
		});

		it('submitCode refreshes files on authenticated', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okJson({ outcome: 'authenticated' }))
				.mockResolvedValueOnce(okJson(inGroup()))
				.mockResolvedValueOnce(okJson({ files: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const out = await telegramService.submitCode('123');
			expect(out.outcome).toBe('authenticated');
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});

		it('submitCode does NOT refresh files when not authenticated', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okJson({ outcome: 'password_required' }))
				.mockResolvedValueOnce(okJson({ state: 'ok' }));
			vi.stubGlobal('fetch', fetchMock);
			const out = await telegramService.submitCode('123');
			expect(out.outcome).toBe('password_required');
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('submitPassword refreshes files on authenticated', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okJson({ outcome: 'authenticated' }))
				.mockResolvedValueOnce(okJson(inGroup()))
				.mockResolvedValueOnce(okJson({ files: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const out = await telegramService.submitPassword('pw');
			expect(out.outcome).toBe('authenticated');
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});

		it('submitPassword does NOT refresh files when not authenticated', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okJson({ outcome: 'failed' }))
				.mockResolvedValueOnce(okJson({ state: 'ok' }));
			vi.stubGlobal('fetch', fetchMock);
			const out = await telegramService.submitPassword('pw');
			expect(out.outcome).toBe('failed');
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('logout clears files and refreshes status', async () => {
			telegramService.files.set([{ id: 'a' }] as never);
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okNoContent()));
			await telegramService.logout();
			expect(get(telegramService.files)).toEqual([]);
		});
	});

	describe('files', () => {
		beforeEach(() => telegramService.status.set(inGroup() as never));

		it('refreshFiles stores files', async () => {
			const files = [{ id: 'a', name: 'x' }];
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ files })));
			await telegramService.refreshFiles();
			expect(get(telegramService.files)).toEqual(files);
		});

		it('refreshFiles captures errors', async () => {
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
			await telegramService.refreshFiles();
			expect(get(telegramService.lastError)).toBe('net');
		});

		it('uploadFile POSTs FormData then refreshes files', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okNoContent())
				.mockResolvedValueOnce(okJson({ files: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const file = new File(['hi'], 'a.txt', { type: 'text/plain' });
			await telegramService.uploadFile(file);
			expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
		});

		it('deleteFile DELETEs and refreshes', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okNoContent()));
			await telegramService.deleteFile('id/with spaces');
		});

		it('deleteAllFiles POSTs delete-all then refreshes', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okNoContent()));
			await telegramService.deleteAllFiles();
		});

		it('downloadUrl encodes the id', () => {
			expect(telegramService.downloadUrl('a b/c', GROUP)).toBe(
				'/api/telegram/files/a%20b%2Fc?group=channel-1'
			);
		});
	});

	describe('uploads', () => {
		beforeEach(() => telegramService.status.set(inGroup() as never));

		it('startUpload POSTs and returns snapshot', async () => {
			const snapshot = { id: 'u', state: 'queued' };
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okJson({ uploadId: 'u', snapshot }))
				.mockResolvedValueOnce(okJson({ uploads: [snapshot] }));
			vi.stubGlobal('fetch', fetchMock);
			const out = await telegramService.startUpload({ path: '/p' });
			expect(out).toEqual(snapshot);
		});

		it('refreshUploads stores uploads on success', async () => {
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ uploads: [{ id: 'u1' }] })));
			await telegramService.refreshUploads();
			expect(get(telegramService.uploads)).toEqual([{ id: 'u1' }]);
		});

		it('refreshUploads captures errors', async () => {
			vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
			await telegramService.refreshUploads();
			expect(get(telegramService.lastError)).toBe('net');
		});

		it('pause/resume/cancel forward to correct endpoints', async () => {
			const fetchMock = vi.fn().mockResolvedValue(okJson({ uploads: [] }));
			vi.stubGlobal('fetch', fetchMock);
			await telegramService.pauseUpload('u 1');
			await telegramService.resumeUpload('u 1');
			await telegramService.cancelUpload('u 1');
			const urls = fetchMock.mock.calls.map((c) => c[0] as string);
			expect(urls).toEqual(
				expect.arrayContaining([
					'/api/telegram/uploads/u%201/pause',
					'/api/telegram/uploads/u%201/resume',
					'/api/telegram/uploads/u%201'
				])
			);
		});

		it('watchUploads is reference-counted', async () => {
			vi.useFakeTimers();
			const fetchMock = vi.fn().mockResolvedValue(okJson({ uploads: [] }));
			vi.stubGlobal('fetch', fetchMock);
			const stop1 = telegramService.watchUploads();
			const stop2 = telegramService.watchUploads();
			await Promise.resolve();
			expect(fetchMock).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1000);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			stop1();
			// Still 1 watcher → keep polling
			await vi.advanceTimersByTimeAsync(1000);
			expect(fetchMock).toHaveBeenCalledTimes(3);
			stop2();
			stop2(); // double-stop is a no-op
			await vi.advanceTimersByTimeAsync(2000);
			expect(fetchMock).toHaveBeenCalledTimes(3);
		});
	});

	describe('groups', () => {
		beforeEach(() => telegramService.status.set(inGroup() as never));

		it('creates with the title and switches', async () => {
			const group = { id: 'channel-2', title: 'New' };
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(okJson({ group }))
				.mockResolvedValueOnce(okJson(inGroup('channel-2')));
			vi.stubGlobal('fetch', fetchMock);
			await telegramService.createGroup('New');
			expect(fetchMock.mock.calls[0][0]).toBe('/api/telegram/groups');
			expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ title: 'New' });
			expect(get(telegramService.status)?.activeGroupId).toBe('channel-2');
		});

		it('drops files that arrive for the group just left', async () => {
			let answer = (_value: unknown) => {};
			vi.stubGlobal(
				'fetch',
				vi.fn().mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
			);
			const loading = telegramService.refreshFiles();
			telegramService.status.set(inGroup('channel-2') as never);
			answer(okJson({ files: [{ id: 'from-group-1' }] }));
			await loading;
			expect(get(telegramService.files)).toEqual([]);
		});

		it('ignores a status sent before the switch', async () => {
			let answerStale = (_value: unknown) => {};
			const fetchMock = vi
				.fn()
				.mockReturnValueOnce(new Promise((resolve) => (answerStale = resolve)))
				.mockResolvedValueOnce(okJson({ group: { id: 'channel-2', title: 'Two' } }))
				.mockResolvedValueOnce(okJson(inGroup('channel-2')));
			vi.stubGlobal('fetch', fetchMock);
			const stale = telegramService.refreshStatus();
			await telegramService.selectGroup('channel-2');
			answerStale(okJson(inGroup('channel-1')));
			await stale;
			expect(get(telegramService.status)?.activeGroupId).toBe('channel-2');
		});

		it('clears the files when another tab switches', async () => {
			telegramService.files.set([{ id: 'a' }] as never);
			vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson(inGroup('channel-2'))));
			await telegramService.refreshStatus();
			expect(get(telegramService.files)).toEqual([]);
		});

		it('names the group when deleting everything', async () => {
			const fetchMock = vi.fn().mockResolvedValue(okJson({ files: [] }));
			vi.stubGlobal('fetch', fetchMock);
			await telegramService.deleteAllFiles();
			expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ groupId: GROUP });
		});

		it('refuses to upload without a group', async () => {
			telegramService.status.set(inGroup(null) as never);
			await expect(telegramService.startUpload({ path: '/p' })).rejects.toThrow('group');
		});
	});

	describe('clearError', () => {
		it('resets the lastError store', () => {
			telegramService.lastError.set('x');
			telegramService.clearError();
			expect(get(telegramService.lastError)).toBeNull();
		});
	});
});

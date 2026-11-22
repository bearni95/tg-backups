import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '../../../src/routes/+page.svelte';
import { telegramService } from '../../../src/services/telegram.service';
import type { TelegramGroup, TelegramStatus } from '../../../src/types/telegram.type';

// The real page and service over a small fake API.
let groups: TelegramGroup[];
let active: string | null;
let info: { autoDeleteSeconds: number | null; historyHidden: boolean };
let failSelect: boolean;
let requests: { url: string; body: unknown }[];

const status = (): TelegramStatus => ({
	hasCredentials: true,
	connected: true,
	signedIn: true,
	authorized: true,
	loginInProgress: null,
	codeDelivery: null,
	user: null,
	groups: [...groups],
	activeGroupId: active
});

function json(value: unknown, code = 200) {
	return new Response(JSON.stringify(value), { status: code });
}

async function api(url: string, init?: RequestInit) {
	const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
	requests.push({ url, body });

	if (url.endsWith('/status')) return json(status());
	if (url.endsWith('/uploads')) return json({ uploads: [] });
	if (url.endsWith('/groups/available'))
		return json({ groups: [{ id: 'channel-9', title: 'TGB-Family' }] });
	if (url.endsWith('/groups/select')) {
		if (failSelect) return json({ error: 'no access', code: 'group_unavailable' }, 409);
		let group = groups.find((known) => known.id === body.id);
		if (!group) {
			group = { id: body.id, title: 'TGB-Family' };
			groups.push(group);
		}
		active = group.id;
		return json({ group });
	}
	if (url.endsWith('/groups')) {
		const group = { id: 'channel-5', title: body.title };
		groups.push(group);
		active = group.id;
		return json({ group });
	}
	const groupId = /\/groups\/([^/?]+)$/.exec(url)?.[1];
	if (groupId) return json({ id: groupId, title: 'T', invite: 'https://t.me/+abc', ...info });
	if (url.includes('/files?group=')) {
		const id = url.split('group=')[1];
		const file = {
			id: `file-${id}`,
			name: `${id}.zip`,
			sizeBytes: 3,
			complete: true,
			mimeType: 'application/zip',
			createdAt: '2026-11-22T10:00:00+00:00'
		};
		return json({ files: [file] });
	}
	throw new Error(`unexpected ${url}`);
}

beforeEach(() => {
	groups = [];
	active = null;
	info = { autoDeleteSeconds: null, historyHidden: false };
	failSelect = false;
	requests = [];
	telegramService.files.set([]);
	telegramService.uploads.set([]);
	telegramService.groupInfo.set(null);
	telegramService.availableGroups.set(null);
	telegramService.lastError.set(null);
	vi.stubGlobal('fetch', vi.fn(api));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function open() {
	telegramService.status.set(status());
	return render(Page);
}

function twoGroups() {
	groups = [
		{ id: 'channel-1', title: 'One' },
		{ id: 'channel-2', title: 'Two' }
	];
	active = 'channel-1';
}

describe('groups on the page', () => {
	it('starts by asking where backups go', () => {
		const view = open();
		expect(view.getByText('Where should backups be stored?')).toBeInTheDocument();
		expect(view.queryByText('New backup')).toBeNull();
		expect(view.queryByText('Cancel')).toBeNull();
	});

	it('creates a group and moves on to backups', async () => {
		const view = open();
		const button = view.getByRole('button', { name: 'Create group' }) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(view.getByText('TGB-', { exact: true })).toBeInTheDocument();
		await fireEvent.input(view.getByLabelText('Group name'), { target: { value: ' My backups ' } });
		await fireEvent.click(button);

		await waitFor(() => expect(view.getByText('channel-5.zip')).toBeInTheDocument());
		expect(requests.find((request) => request.url.endsWith('/groups'))?.body).toEqual({
			title: 'TGB-My backups'
		});
		expect(view.getByText('New backup')).toBeInTheDocument();
		expect(view.queryByText('Where should backups be stored?')).toBeNull();
	});

	it('uses an existing group', async () => {
		const view = open();
		await fireEvent.click(view.getByRole('button', { name: 'Show my groups' }));
		const select = (await view.findByLabelText('Existing group')) as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: 'channel-9' } });
		await fireEvent.click(view.getByRole('button', { name: 'Use group' }));
		await waitFor(() => expect(view.getByText('channel-9.zip')).toBeInTheDocument());
	});

	it('switches groups, files and download links included', async () => {
		twoGroups();
		const view = open();
		await view.findByText('channel-1.zip');
		await fireEvent.change(view.getByLabelText('Backup group'), { target: { value: 'channel-2' } });

		await view.findByText('channel-2.zip');
		expect(view.queryByText('channel-1.zip')).toBeNull();
		expect(view.getByText('Restore').getAttribute('href')).toBe(
			'/api/telegram/files/file-channel-2?group=channel-2'
		);
		expect((view.getByLabelText('Backup group') as HTMLSelectElement).value).toBe('channel-2');
	});

	it('stays on the group when a switch fails', async () => {
		twoGroups();
		failSelect = true;
		const view = open();
		await view.findByText('channel-1.zip');
		await fireEvent.change(view.getByLabelText('Backup group'), { target: { value: 'channel-2' } });

		await view.findByText('no access');
		expect((view.getByLabelText('Backup group') as HTMLSelectElement).value).toBe('channel-1');
		expect(view.getByText('channel-1.zip')).toBeInTheDocument();
	});

	it('adds another group', async () => {
		twoGroups();
		const view = open();
		await fireEvent.click(view.getByRole('button', { name: 'Add group' }));
		expect(view.getByLabelText('Group name')).toBeInTheDocument();
		await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
		expect(view.queryByLabelText('Group name')).toBeNull();
	});

	it('shares the invite', async () => {
		twoGroups();
		const view = open();
		await fireEvent.click(await view.findByRole('button', { name: 'Share' }));
		expect((view.getByLabelText('Telegram invite link') as HTMLInputElement).value).toBe(
			'https://t.me/+abc'
		);
	});

	it('warns about auto-delete and hidden history', async () => {
		twoGroups();
		info = { autoDeleteSeconds: 604800, historyHidden: true };
		const view = open();
		expect(await view.findByText(/deletes messages after/)).toBeInTheDocument();
		expect(view.getByText(/can't see older messages/)).toBeInTheDocument();
	});
});

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import TelegramFileRow from '../../../src/components/telegram/TelegramFileRow.svelte';
import type { TelegramFile } from '../../../src/types/telegram.type';

const baseFile: TelegramFile = {
	id: 'file-1',
	name: 'backup.zip',
	sizeBytes: 1024 * 1024,
	mimeType: 'application/zip',
	complete: true,
	createdAt: '2024-01-01T00:00:00.000Z',
	checksumSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
};

describe('TelegramFileRow', () => {
	it('renders the name, size, formatted date, and trimmed sha', () => {
		const { getByText, container } = render(TelegramFileRow, {
			props: {
				file: baseFile,
				downloadUrl: '/api/telegram/files/file-1',
				onDelete: vi.fn()
			}
		});
		expect(getByText('backup.zip')).toBeInTheDocument();
		expect(getByText('file-1')).toBeInTheDocument();
		expect(getByText('1.00 MB')).toBeInTheDocument();
		expect(container.textContent).toContain('SHA-256');
		expect(container.textContent).toContain('0123456789ab');
	});

	it('falls back to the raw createdAt string when invalid date', () => {
		const f = { ...baseFile, createdAt: 'not-a-date' };
		const { getByText } = render(TelegramFileRow, {
			props: { file: f, downloadUrl: '/api/dl', onDelete: vi.fn() }
		});
		expect(getByText('not-a-date')).toBeInTheDocument();
	});

	it('omits the SHA block when checksumSha256 is missing', () => {
		const f: TelegramFile = { ...baseFile, checksumSha256: undefined };
		const { container } = render(TelegramFileRow, {
			props: { file: f, downloadUrl: '/api/dl', onDelete: vi.fn() }
		});
		expect(container.textContent).not.toContain('SHA-256');
	});

	it('renders the download link with the right href + download attribute', () => {
		const { container } = render(TelegramFileRow, {
			props: { file: baseFile, downloadUrl: '/api/dl-abc', onDelete: vi.fn() }
		});
		const a = container.querySelector('a') as HTMLAnchorElement;
		expect(a.getAttribute('href')).toBe('/api/dl-abc');
		expect(a.getAttribute('download')).toBe('backup.zip');
	});

	it('invokes onDelete with the file id only once the delete is confirmed', async () => {
		const onDelete = vi.fn();
		const { getByText } = render(TelegramFileRow, {
			props: { file: baseFile, downloadUrl: '/api/dl', onDelete }
		});
		await fireEvent.click(getByText('Delete'));
		expect(onDelete).not.toHaveBeenCalled();
		await fireEvent.click(getByText('Confirm delete'));
		expect(onDelete).toHaveBeenCalledWith('file-1');
	});

	it('offers no restore for an incomplete backup', () => {
		const { container, getByText } = render(TelegramFileRow, {
			props: { file: { ...baseFile, complete: false }, downloadUrl: '/api/dl', onDelete: vi.fn() }
		});
		expect(getByText('Incomplete')).toBeInTheDocument();
		expect(container.querySelector('a')).toBeNull();
	});
});

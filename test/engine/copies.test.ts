// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { telegramMarkerAdapter } from '../../src/adapters/classes/telegram-marker.adapter';
import { BufferSource } from '../../src/lib/telegram/byte-source';
import type { BackupGroup } from '../../src/lib/telegram/backup-group';
import { walkAndMint } from '../../src/lib/telegram/reconcile';
import { useBackend } from './support/harness';

const backend = useBackend();

function chunk(index: number, total: number, content: string, size: number) {
	const caption = telegramMarkerAdapter.toCaption({
		groupId: 'same',
		index,
		total,
		name: 'db.tgb-0123456789ab.zip',
		size,
		mime: 'application/zip',
		caption: null,
		checksum: null,
		partChecksum: null,
		metadata: undefined
	});
	return backend.telegram.addDocument(`part${index}`, Buffer.from(content), { caption });
}

async function restore(group: BackupGroup, id: string) {
	const pieces: Uint8Array[] = [];
	for await (const piece of await group.files.download(id)) pieces.push(piece);
	return Buffer.concat(pieces).toString();
}

const walk = (group: BackupGroup) => walkAndMint(group, { kind: 'all' });

describe('copies of the same backup', () => {
	it('all show on a machine that rebuilds, so deleting them empties Telegram', async () => {
		const first = await backend.group();
		for (let i = 0; i < 3; i++) {
			await first.files.uploadSource(
				{ name: 'db.zip', mimeType: 'application/zip', totalSize: 9 },
				new BufferSource(Buffer.from('identical'))
			);
		}
		const root = join(backend.root, 'other');
		mkdirSync(root);
		const other = await backend.group(root);
		await walk(other);

		expect(other.db.list()).toHaveLength(3);
		for (const row of other.db.list()) await other.files.delete(row.id);
		expect(backend.telegram.messages).toEqual([]);
	});

	it('deleting one leaves the other restorable', async () => {
		for (let copy = 0; copy < 2; copy++) {
			chunk(0, 2, 'AAA', 5);
			chunk(1, 2, 'BB', 5);
		}
		const group = await backend.group();
		await walk(group);
		const [one, two] = group.db.list();
		expect(await restore(group, one.id)).toBe('AAABB');
		await group.files.delete(one.id);
		expect(await restore(group, two.id)).toBe('AAABB');
		expect(await walk(group)).toEqual([]);
	});

	it('are stable from one walk to the next', async () => {
		chunk(0, 1, 'A', 1);
		chunk(0, 1, 'A', 1);
		const group = await backend.group();
		expect(await walk(group)).toHaveLength(2);
		expect(await walk(group)).toEqual([]);
	});

	it("don't count a partial second copy", async () => {
		chunk(0, 2, 'AAA', 5);
		chunk(0, 2, 'AAA', 5);
		chunk(1, 2, 'BB', 5);
		const group = await backend.group();
		expect(await walk(group)).toHaveLength(1);
	});

	it("don't count a staged chunk seen again", async () => {
		const group = await backend.group();
		chunk(0, 2, 'AAA', 5);
		await walk(group);
		chunk(1, 2, 'BB', 5);
		expect(await walk(group)).toHaveLength(1);
	});
});

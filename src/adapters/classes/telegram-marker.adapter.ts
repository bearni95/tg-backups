import { AdapterClass } from '$adapters/classes/adapter.class';
import { asObject, parseJson, stringifyCanonical } from '$utils/json/losslessJson';
import type { MultipartMarker } from '$types/telegram-engine.type';

// Keep the schema stable: it is what is already written in the group.
const KIND = 'tgb-multipart';
const VERSION = 2;

function count(value: unknown): number | null {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

/** The JSON caption on every chunk message, from which any machine can rebuild the index. */
export class TelegramMarkerAdapter extends AdapterClass {
	constructor() {
		super('telegram-marker');
	}

	toCaption(marker: MultipartMarker & { groupId: string }): string {
		return stringifyCanonical({
			v: VERSION,
			kind: KIND,
			groupId: marker.groupId,
			index: marker.index,
			total: marker.total,
			name: marker.name,
			size: marker.size,
			mime: marker.mime,
			caption: marker.caption,
			checksum: marker.checksum,
			partChecksum: marker.partChecksum,
			metadata: marker.metadata ?? null
		});
	}

	/** Reads v1 (caption only) and v2 (checksums and metadata). */
	fromCaption(caption: string): MultipartMarker | null {
		const trimmed = caption.trim();
		if (!trimmed.startsWith('{')) return null;

		let parsed: unknown;
		try {
			parsed = parseJson(trimmed);
		} catch {
			return null;
		}
		const value = asObject(parsed);
		if (value?.kind !== KIND || (value.v !== 1 && value.v !== 2)) return null;
		if (text(value.groupId) === null) return null;

		const index = count(value.index);
		const total = count(value.total);
		const size = count(value.size);
		const name = text(value.name);
		if (index === null || total === null || size === null || name === null) return null;

		return {
			index,
			total,
			name,
			size,
			mime: text(value.mime) ?? 'application/octet-stream',
			caption: text(value.caption),
			checksum: text(value.checksum),
			partChecksum: text(value.partChecksum),
			metadata: value.metadata ?? undefined
		};
	}
}

export const telegramMarkerAdapter = new TelegramMarkerAdapter();

import type { Long, tl } from '@mtcute/node';

/** An addressable Telegram peer: bare id plus access hash. */
export interface PeerRef {
	kind: 'user' | 'chat' | 'channel';
	id: number;
	accessHash: Long;
}

/** A row of `tg_files`: one logical backup. */
export interface FileRow {
	id: string;
	/** The stored name, content fingerprint included. */
	name: string;
	sizeBytes: number;
	mimeType: string;
	/** The message holding chunk 0. */
	tgMessageId: number;
	createdAt: string;
	text: string | null;
	/** Null for resumed and reconciled rows, which never saw every byte. */
	checksumSha256: string | null;
	metadata: string | null;
}

/** A row of `tg_file_part`: one Telegram message holding a slice of a backup. */
export interface FilePart {
	ord: number;
	tgMessageId: number;
	sizeBytes: number;
	checksumSha256: string | null;
}

/** A row of `tg_pending_part`: a chunk seen in the group whose backup isn't complete yet. */
export interface PendingChunk {
	groupId: string;
	ord: number;
	tgMessageId: number;
	sizeBytes: number;
	partChecksum: string | null;
	total: number;
	name: string;
	declaredSize: number;
	mime: string;
	caption: string | null;
	checksum: string | null;
	metadata: string | null;
}

/** A complete multipart group, ready to become a `tg_files` row. */
export interface MintGroup {
	name: string;
	finalSize: number;
	mime: string;
	caption: string | null;
	checksum: string | null;
	metadata: string | null;
	chunks: FilePart[];
}

/** The parsed `tgb-multipart` caption of a chunk message. */
export interface MultipartMarker {
	index: number;
	total: number;
	name: string;
	size: number;
	mime: string;
	caption: string | null;
	checksum: string | null;
	partChecksum: string | null;
	/** Opaque caller JSON; undefined when the marker carries none. */
	metadata: unknown;
}

/** A document attached to a message in the group. */
export interface StoredDocument {
	name: string | null;
	size: number;
	mimeType: string;
	dcId: number;
	location: tl.RawInputDocumentFileLocation;
}

/**
 * `<data root>/telegram/session.sqlite`. Despite the name it is JSON, in the
 * grammers layout, so sessions and transfer payloads from earlier versions keep working.
 */
export interface SessionData {
	home_dc: number;
	dc_options: SessionDcOption[];
	/** Externally tagged: `{ User }`, `{ Chat }` or `{ Channel }`. */
	peer_infos: Record<string, Record<string, unknown>>[];
	updates_state: SessionUpdatesState;
}

export interface SessionDcOption {
	id: number;
	/** `ip:port` */
	ipv4: string;
	/** `[ip]:port` */
	ipv6: string;
	/** 256 bytes, hex. */
	auth_key: string | null;
}

export interface SessionUpdatesState {
	pts: number;
	qts: number;
	date: number;
	seq: number;
	channels: { id: number; pts: number }[];
}

/** `<data root>/telegram/credentials.json` */
export interface StoredCredentials {
	api_id: number;
	api_hash: string;
}

export interface TransferPayload {
	v: 1;
	kind: 'tgb-telegram-transfer';
	scope: 'credentials' | 'full';
	credentials: { apiId: number; apiHash: string };
	session?: unknown;
}

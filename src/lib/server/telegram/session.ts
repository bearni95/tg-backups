import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import type { Long } from '@mtcute/node';
import { describeError, log } from '$lib/server/logger';
import { telegramSessionAdapter } from '$adapters/classes/telegram-session.adapter';
import { rawInteger } from '$utils/json/losslessJson';
import type {
	SessionData,
	SessionDcOption,
	SessionUpdatesState
} from '$types/telegram-server.type';

/** Replace a file atomically and owner-only, so a crash can't leave half of it. */
export function writePrivateFile(path: string, text: string): void {
	const extension = extname(path);
	const temporary = `${extension ? path.slice(0, -extension.length) : path}.json.tmp`;
	writeFileSync(temporary, text, { mode: 0o600 });
	// The mode above only applies when the file is new.
	chmodSync(temporary, 0o600);
	renameSync(temporary, path);
}

/** The MTProto session: home DC, one auth key per DC, and who is signed in. */
export class FileSession {
	private closed = false;

	private constructor(
		private readonly path: string,
		private readonly data: SessionData
	) {}

	static open(path: string): FileSession {
		mkdirSync(dirname(path), { recursive: true });

		let text = '';
		try {
			text = readFileSync(path, 'utf8');
		} catch (error) {
			// Only a missing file is a fresh start: anything else would be overwritten.
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}

		let data: SessionData | null = null;
		if (text !== '') {
			data = telegramSessionAdapter.fromFile(text);
			if (!data) log.warn(`session file ${path} is unreadable; starting fresh`);
		}
		return new FileSession(path, data ?? telegramSessionAdapter.empty());
	}

	get homeDcId(): number {
		return this.data.home_dc;
	}

	setHomeDc(id: number, address?: { ip: string; port: number }): void {
		this.data.home_dc = id;
		const ipv4 = address && !address.ip.includes(':') ? `${address.ip}:${address.port}` : null;
		if (ipv4) this.ensureDc(id).ipv4 = ipv4;
		this.save();
	}

	dcOption(id: number): SessionDcOption | null {
		return this.data.dc_options.find((dc) => dc.id === id) ?? null;
	}

	authKey(id: number): Uint8Array | null {
		const hex = this.dcOption(id)?.auth_key;
		return hex ? new Uint8Array(Buffer.from(hex, 'hex')) : null;
	}

	setAuthKey(id: number, key: Uint8Array | null): void {
		this.ensureDc(id).auth_key = key ? Buffer.from(key).toString('hex') : null;
		this.save();
	}

	get updatesState(): SessionUpdatesState {
		return this.data.updates_state;
	}

	setUpdatesState(state: SessionUpdatesState): void {
		this.data.updates_state = state;
		this.save();
	}

	setSelf(user: { id: number; accessHash: Long; bot: boolean }): void {
		const info = {
			User: {
				id: user.id,
				auth: rawInteger(user.accessHash.toString()),
				bot: user.bot,
				is_self: true
			}
		};
		this.data.peer_infos = this.data.peer_infos.filter((peer) => peer.User?.id !== user.id);
		this.data.peer_infos.push(info);
		this.save();
	}

	/** Stop writing. A replaced client must not trample the session that replaced it. */
	close(): void {
		this.closed = true;
	}

	private ensureDc(id: number): SessionDcOption {
		let dc = this.dcOption(id);
		if (!dc) {
			dc = { id, ipv4: '0.0.0.0:443', ipv6: '[::]:443', auth_key: null };
			this.data.dc_options.push(dc);
		}
		return dc;
	}

	private save(): void {
		if (this.closed) return;
		try {
			writePrivateFile(this.path, telegramSessionAdapter.toFile(this.data));
		} catch (error) {
			log.error(`session write to ${this.path} failed: ${describeError(error)}`);
		}
	}
}

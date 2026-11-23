import { AdapterClass } from '$adapters/classes/adapter.class';
import { asObject, parseJson } from '$utils/json/losslessJson';
import type {
	SessionData,
	SessionDcOption,
	SessionUpdatesState
} from '$types/telegram-engine.type';

const DEFAULT_DC = 2;

const KNOWN_DCS: readonly SessionDcOption[] = [
	['149.154.175.53', '2001:b28:f23d:f001::a'],
	['149.154.167.41', '2001:67c:4e8:f002::a'],
	['149.154.175.100', '2001:b28:f23d:f003::a'],
	['149.154.167.92', '2001:67c:4e8:f004::a'],
	['91.108.56.104', '2001:b28:f23f:f005::a']
].map(([ipv4, ipv6], index) => ({
	id: index + 1,
	ipv4: `${ipv4}:443`,
	ipv6: `[${ipv6}]:443`,
	auth_key: null
}));

function isInt(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value);
}

function parseDcOption(value: unknown): SessionDcOption | null {
	const dc = asObject(value);
	if (!dc || !isInt(dc.id)) return null;
	const { id, ipv4, ipv6 } = dc;
	const key = dc.auth_key ?? null;
	if (typeof ipv4 !== 'string' || !/^[\d.]+:\d+$/.test(ipv4)) return null;
	if (typeof ipv6 !== 'string' || !/^\[[^\]]+\]:\d+$/.test(ipv6)) return null;
	if (key !== null && (typeof key !== 'string' || !/^[0-9a-fA-F]{512}$/.test(key))) return null;
	return { id, ipv4, ipv6, auth_key: key };
}

function parseUpdatesState(value: unknown): SessionUpdatesState | null {
	const state = asObject(value);
	if (!state || !Array.isArray(state.channels)) return null;
	const { pts, qts, date, seq } = state;
	if (!isInt(pts) || !isInt(qts) || !isInt(date) || !isInt(seq)) return null;
	return { pts, qts, date, seq, channels: state.channels as SessionUpdatesState['channels'] };
}

export class TelegramSessionAdapter extends AdapterClass {
	constructor() {
		super('telegram-session');
	}

	empty(): SessionData {
		return {
			home_dc: DEFAULT_DC,
			dc_options: KNOWN_DCS.map((dc) => ({ ...dc })),
			peer_infos: [],
			updates_state: { pts: 0, qts: 0, date: 0, seq: 0, channels: [] }
		};
	}

	/** Null when the text isn't a session. Known DCs the file omits are filled in. */
	fromFile(text: string): SessionData | null {
		let parsed: unknown;
		try {
			parsed = parseJson(text);
		} catch {
			return null;
		}
		const file = asObject(parsed);
		if (!file || !isInt(file.home_dc)) return null;
		if (!Array.isArray(file.dc_options) || !Array.isArray(file.peer_infos)) return null;

		const updates = parseUpdatesState(file.updates_state);
		if (!updates || !file.peer_infos.every((peer) => asObject(peer) !== null)) return null;

		const dcs = new Map(KNOWN_DCS.map((dc) => [dc.id, { ...dc }]));
		for (const entry of file.dc_options) {
			const dc = parseDcOption(entry);
			if (!dc) return null;
			dcs.set(dc.id, dc);
		}

		return {
			home_dc: file.home_dc,
			dc_options: [...dcs.values()],
			peer_infos: file.peer_infos as SessionData['peer_infos'],
			updates_state: updates
		};
	}

	toFile(session: SessionData): string {
		return JSON.stringify(session);
	}
}

export const telegramSessionAdapter = new TelegramSessionAdapter();

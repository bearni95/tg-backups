// TGB_TELEGRAM_ACCESS_GROUP is a private invite link, a public @username, or a numeric chat id.
const I64_MAX = 2n ** 63n - 1n;

function stripPrefix(value: string, ...prefixes: string[]): string {
	const prefix = prefixes.find((candidate) => value.startsWith(candidate));
	return prefix === undefined ? value : value.slice(prefix.length);
}

/** The hash of `t.me/+<hash>`, `t.me/joinchat/<hash>` or a bare `+<hash>`. */
export function parseInviteHash(spec: string): string | null {
	const path = stripPrefix(
		stripPrefix(spec.trim(), 'https://', 'http://'),
		't.me/',
		'telegram.me/'
	);
	for (const prefix of ['+', 'joinchat/']) {
		if (path.startsWith(prefix)) return path.slice(prefix.length) || null;
	}
	return null;
}

/** The bare username. Usernames start with a letter, so a numeric spec is never one. */
export function parseGroupUsername(spec: string): string | null {
	const value = spec.trim();
	if (value.startsWith('@')) return value.slice(1) || null;
	const numeric = value !== '' && /^[0-9]*$/.test(value.replace(/^-+/, ''));
	return numeric ? null : value;
}

/** Bare ids a numeric spec may mean: as written, and without the `-100` supergroup prefix. */
export function parseGroupIdCandidates(spec: string): number[] | null {
	const digits = spec.trim().replace(/^-+/, '');
	if (!/^[0-9]+$/.test(digits)) return null;

	const ids: number[] = [];
	const add = (text: string) => {
		if (text === '' || BigInt(text) > I64_MAX) return;
		const id = Number(text);
		if (!ids.includes(id)) ids.push(id);
	};
	add(digits);
	if (digits.startsWith('100')) add(digits.slice(3));
	return ids.length > 0 ? ids : null;
}

/** A shareable link for the group; null for a numeric id, which has none. */
export function accessGroupInviteUrl(spec: string | null): string | null {
	if (spec === null) return null;
	const hash = parseInviteHash(spec);
	if (hash) return `https://t.me/+${hash}`;
	if (parseGroupIdCandidates(spec)) return null;
	const username = parseGroupUsername(spec);
	return username === null ? null : `https://t.me/${username}`;
}

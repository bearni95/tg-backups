const U64_MAX = 2n ** 64n - 1n;

function parseU64(text: string): bigint | null {
	if (!/^\+?[0-9]+$/.test(text)) return null;
	const value = BigInt(text);
	return value <= U64_MAX ? value : null;
}

/**
 * The first range of a `Range: bytes=…` header as inclusive offsets, or null
 * when it can't be satisfied. Supports `N-M`, `N-` and `-N`.
 */
export function parseByteRange(
	header: string,
	length: number
): { start: number; end: number } | null {
	if (!header.startsWith('bytes=')) return null;
	const first = header.slice('bytes='.length).split(',')[0].trim();
	const dash = first.indexOf('-');
	if (dash < 0) return null;

	const total = BigInt(length);
	const startText = first.slice(0, dash);
	const endText = first.slice(dash + 1);

	if (startText === '') {
		const suffix = parseU64(endText);
		if (!suffix || total === 0n) return null;
		const size = suffix < total ? suffix : total;
		return { start: Number(total - size), end: length - 1 };
	}

	const start = parseU64(startText);
	const end = endText === '' ? (total === 0n ? 0n : total - 1n) : parseU64(endText);
	if (start === null || end === null || start > end || start >= total) return null;
	return { start: Number(start), end: Number(end < total ? end : total - 1n) };
}

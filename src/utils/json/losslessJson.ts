// Telegram access hashes and caller metadata hold 64-bit integers, which plain
// JSON.parse rounds. These keep them as raw JSON (Node 22+) instead.
const json = JSON as typeof JSON & {
	rawJSON(text: string): object;
	isRawJSON(value: unknown): boolean;
};

const INTEGER = /^-?\d+$/;

/** `JSON.parse` that never rounds an integer. */
export function parseJson(text: string): unknown {
	const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
		typeof value === 'number' &&
		!Number.isSafeInteger(value) &&
		context?.source !== undefined &&
		INTEGER.test(context.source)
			? json.rawJSON(context.source)
			: value;
	return JSON.parse(text, reviver);
}

/** A 64-bit integer as a value `JSON.stringify` writes out exactly. */
export function rawInteger(digits: string): number | object {
	if (!INTEGER.test(digits)) throw new Error(`not an integer: ${digits}`);
	const value = Number(digits);
	return Number.isSafeInteger(value) ? value : json.rawJSON(digits);
}

/** The value as a plain object, or null for anything else. */
export function asObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
	return json.isRawJSON(value) ? null : (value as Record<string, unknown>);
}

// UTF-16 order differs from UTF-8 order above the BMP, so compare code points.
function byCodePoint(a: string, b: string): number {
	const left = [...a];
	const right = [...b];
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const diff = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
		if (diff !== 0) return diff;
	}
	return left.length - right.length;
}

/**
 * Compact JSON with sorted keys. Captions on Telegram and the metadata column
 * have always been written this way, so the output is byte-for-byte stable.
 */
export function stringifyCanonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stringifyCanonical).join(',')}]`;
	const object = asObject(value);
	if (!object) return JSON.stringify(value ?? null);
	const fields = Object.keys(object)
		.filter((key) => object[key] !== undefined)
		.sort(byCodePoint)
		.map((key) => `${JSON.stringify(key)}:${stringifyCanonical(object[key])}`);
	return `{${fields.join(',')}}`;
}

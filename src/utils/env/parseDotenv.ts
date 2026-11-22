// Node's own .env loader has no `$VAR` substitution and cuts values at any `#`.
// Either would silently move TGB_DATA_DIR, and with it the session, so this keeps
// the syntax existing .env files were written for.

interface Lookup {
	env: Record<string, string | undefined>;
	seen: Map<string, string>;
}

function substitute(name: string, { env, seen }: Lookup): string {
	return (name && env[name]) ?? seen.get(name) ?? '';
}

function parseValue(input: string, lookup: Lookup): string | null {
	let output = '';
	let quote: '"' | "'" | null = null;
	let escaped = false;
	let ended = false;
	let variable: { name: string; braced: boolean } | null = null;

	for (const char of input) {
		if (ended) {
			if (char === ' ' || char === '\t') continue;
			if (char === '#') break;
			return null;
		}
		if (escaped) {
			if (char === 'n') output += '\n';
			else if ('\\\'"$ '.includes(char)) output += char;
			else return null;
			escaped = false;
		} else if (quote === "'") {
			if (char === "'") quote = null;
			else output += char;
		} else if (variable) {
			if (/[\p{Alphabetic}\p{N}]/u.test(char)) {
				variable.name += char;
			} else if (variable.braced) {
				if (char === '}') {
					output += substitute(variable.name, lookup);
					variable = null;
				} else {
					variable.name += char;
				}
			} else if (char === '{' && variable.name === '') {
				variable.braced = true;
			} else {
				output += substitute(variable.name, lookup);
				variable = char === '$' ? { name: '', braced: false } : null;
				// The terminator is literal, except a quote closing the string it is in.
				if (char === '"' && quote === '"') quote = null;
				else if (char !== '$') output += char;
			}
		} else if (char === '$') {
			variable = { name: '', braced: false };
		} else if (char === '\\') {
			escaped = true;
		} else if (quote === '"') {
			if (char === '"') quote = null;
			else output += char;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (char === ' ' || char === '\t') {
			ended = true;
		} else {
			output += char;
		}
	}

	if (quote || variable?.braced) return null;
	return variable ? output + substitute(variable.name, lookup) : output;
}

/** Whether a line leaves a quote open, so the value carries on to the next one. */
function opensQuote(text: string): boolean {
	let quote: string | null = null;
	let escaped = false;
	let afterSpace = true;
	for (const char of text) {
		if (escaped) {
			escaped = false;
		} else if (char === '\\') {
			escaped = true;
		} else if (quote) {
			if (char === quote) quote = null;
		} else if (char === '#' && afterSpace) {
			return false;
		} else if (char === '"' || char === "'") {
			quote = char;
		}
		afterSpace = char === ' ' || char === '\t';
	}
	return quote !== null;
}

/**
 * Parse a .env file. Like the loader it replaces, parsing stops at the first
 * bad line, keeping what came before it.
 */
export function parseDotenv(
	source: string,
	env: Record<string, string | undefined> = {}
): { values: Map<string, string>; error: string | null } {
	const values = new Map<string, string>();
	const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
	const lines = text.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const first = i + 1;
		let entry = lines[i];
		if (entry.trimStart().startsWith('#')) continue;
		while (opensQuote(entry) && i + 1 < lines.length) entry += `\n${lines[++i]}`;

		const line = entry.trim();
		if (line === '') continue;

		// `export KEY=value`, while still allowing a variable named `export`.
		const match = /^(?:export\s+(?!=))?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/s.exec(line);
		// The line itself may hold a secret, so errors only name its number.
		if (!match) return { values, error: `line ${first} is not KEY=value` };

		const [, key, raw] = match;
		// Earlier lines only count where the process environment has no value of its own.
		const value = raw.startsWith('#') ? '' : parseValue(raw, { env, seen: values });
		if (value === null) return { values, error: `line ${first} has an invalid value` };
		// The first of a repeated key wins.
		if (!values.has(key)) values.set(key, value);
	}

	return { values, error: null };
}

// Cron schedules: presets, validation, and a readable label.

/** Words `--schedule` takes in place of a cron expression. */
export const SCHEDULE_PRESETS: Readonly<Record<string, string>> = {
	hourly: '0 * * * *',
	daily: '0 3 * * *',
	weekly: '0 3 * * 0',
	monthly: '0 3 1 * *'
};

const MACROS = new Set([
	'@hourly',
	'@daily',
	'@midnight',
	'@weekly',
	'@monthly',
	'@yearly',
	'@annually'
]);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Field {
	name: string;
	min: number;
	max: number;
	names?: string[];
	/** The number the first name stands for. */
	namesFrom?: number;
}

const FIELDS: Field[] = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day of month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12, names: MONTHS, namesFrom: 1 },
	{ name: 'day of week', min: 0, max: 7, names: DAYS, namesFrom: 0 }
];

function valueOf(text: string, field: Field): number | null {
	const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
	if (named >= 0) return named + (field.namesFrom ?? 0);
	if (!/^\d+$/.test(text)) return null;
	const value = Number(text);
	return value >= field.min && value <= field.max ? value : null;
}

function checkPart(part: string, field: Field): string | null {
	const [range, step, extra] = part.split('/');
	if (extra !== undefined) return `bad ${field.name} "${part}"`;
	if (step !== undefined && (!/^\d+$/.test(step) || Number(step) === 0)) {
		return `bad step in ${field.name} "${part}"`;
	}
	if (range === '*') return null;
	const [from, to, more] = range.split('-');
	if (more !== undefined) return `bad ${field.name} "${part}"`;
	const start = valueOf(from, field);
	if (start === null) return `${field.name} must be ${field.min}-${field.max}, got "${from}"`;
	if (to === undefined) return null;
	const end = valueOf(to, field);
	if (end === null) return `${field.name} must be ${field.min}-${field.max}, got "${to}"`;
	return end < start ? `${field.name} range "${range}" runs backwards` : null;
}

/** Why a cron expression won't run, or null when it is fine. */
export function cronProblem(expression: string): string | null {
	const text = expression.trim();
	if (text.startsWith('@')) {
		return MACROS.has(text.toLowerCase()) ? null : `unknown cron macro "${text}"`;
	}
	const parts = text.split(/\s+/);
	if (parts.length !== 5 || text === '') {
		return 'a cron expression has five fields: minute hour day-of-month month day-of-week';
	}
	for (const [index, part] of parts.entries()) {
		for (const piece of part.split(',')) {
			const problem = checkPart(piece, FIELDS[index]);
			if (problem) return problem;
		}
	}
	return null;
}

/** A preset word or a cron expression, as the cron expression to store. */
export function parseSchedule(
	text: string
): { ok: true; cron: string } | { ok: false; error: string } {
	const trimmed = text.trim();
	const preset = SCHEDULE_PRESETS[trimmed.toLowerCase()];
	if (preset) return { ok: true, cron: preset };
	const problem = cronProblem(trimmed);
	if (problem) return { ok: false, error: problem };
	return { ok: true, cron: trimmed.split(/\s+/).join(' ') };
}

/** `3:05` or `03:05` → `{ hour: 3, minute: 5 }`; null when it isn't a time of day. */
export function parseClock(text: string): { hour: number; minute: number } | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** `0 3 * * *` → `every day at 03:00`; anything unusual stays as it is. */
export function describeSchedule(cron: string): string {
	const macro = cron.trim().toLowerCase();
	if (macro === '@hourly') return 'every hour';
	if (macro === '@daily' || macro === '@midnight') return 'every day at 00:00';
	if (macro === '@weekly') return 'every Sunday at 00:00';
	if (macro === '@monthly') return 'on the 1st of every month at 00:00';
	if (macro === '@yearly' || macro === '@annually') return 'every year on 1 January at 00:00';

	const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
	const plain = (value: string | undefined) => value !== undefined && /^\d+$/.test(value);
	if (!plain(minute)) return `cron ${cron}`;
	const at = (h: string) => `${h.padStart(2, '0')}:${minute.padStart(2, '0')}`;

	if (hour === '*' && dom === '*' && month === '*' && dow === '*') {
		return minute === '0' ? 'every hour' : `every hour at minute ${minute}`;
	}
	const everyHours = /^\*\/(\d+)$/.exec(hour ?? '');
	if (everyHours && dom === '*' && month === '*' && dow === '*') {
		return `every ${everyHours[1]} hours at minute ${minute}`;
	}
	if (!plain(hour) || month !== '*') return `cron ${cron}`;
	if (dom === '*' && dow === '*') return `every day at ${at(hour)}`;
	if (dom === '*' && plain(dow)) {
		const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
			Number(dow) % 7
		];
		return `every ${day} at ${at(hour)}`;
	}
	if (plain(dom) && dow === '*') return `on day ${dom} of every month at ${at(hour)}`;
	return `cron ${cron}`;
}

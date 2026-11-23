// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { cronLine, replaceCronBlock, shellQuote } from '../../src/utils/cron/crontabBlock';
import {
	cronProblem,
	describeSchedule,
	parseClock,
	parseSchedule
} from '../../src/utils/cron/schedule';

const RUN = {
	node: '/usr/bin/node',
	script: '/opt/tgb/dist/cli.js',
	dataRoot: '/home/me/tg-backups',
	logFile: '/home/me/tg-backups/cron.log'
};

describe('schedules', () => {
	it('turns presets into cron expressions', () => {
		expect(parseSchedule('daily')).toEqual({ ok: true, cron: '0 3 * * *' });
		expect(parseSchedule('Hourly')).toEqual({ ok: true, cron: '0 * * * *' });
		expect(parseSchedule(' 30  2 * * 1-5 ')).toEqual({ ok: true, cron: '30 2 * * 1-5' });
		expect(parseSchedule('@weekly')).toEqual({ ok: true, cron: '@weekly' });
	});

	it.each([
		'',
		'* * * *',
		'60 * * * *',
		'0 24 * * *',
		'0 0 0 * *',
		'*/0 * * * *',
		'5-1 * * * *',
		'@reboot',
		'@sometimes'
	])('refuses %j', (text) => {
		expect(parseSchedule(text).ok).toBe(false);
	});

	it('takes lists, steps and names', () => {
		expect(cronProblem('0,15,30,45 */2 1-15/2 jan-jun mon,fri')).toBeNull();
		expect(cronProblem('0 3 * * 7')).toBeNull();
	});

	it('describes common schedules', () => {
		expect(describeSchedule('0 3 * * *')).toBe('every day at 03:00');
		expect(describeSchedule('0 * * * *')).toBe('every hour');
		expect(describeSchedule('0 */6 * * *')).toBe('every 6 hours at minute 0');
		expect(describeSchedule('15 22 * * 1')).toBe('every Monday at 22:15');
		expect(describeSchedule('0 3 1 * *')).toBe('on day 1 of every month at 03:00');
		expect(describeSchedule('0 3 * 2 *')).toBe('cron 0 3 * 2 *');
	});

	it('reads times of day', () => {
		expect(parseClock('3:05')).toEqual({ hour: 3, minute: 5 });
		expect(parseClock('24:00')).toBeNull();
		expect(parseClock('noon')).toBeNull();
	});
});

describe('crontab block', () => {
	it('quotes for the shell only when needed', () => {
		expect(shellQuote('/usr/bin/node')).toBe('/usr/bin/node');
		expect(shellQuote("/my dir/it's")).toBe(`'/my dir/it'\\''s'`);
	});

	it('runs the tracked id through node, logging, with % escaped', () => {
		const line = cronLine({ id: 'abc123', schedule: '0 3 * * *' }, { ...RUN, dataRoot: '/d/50%' });
		expect(line).toBe(
			'0 3 * * * /usr/bin/node /opt/tgb/dist/cli.js --data-dir /d/50\\% tracked run abc123 >> /home/me/tg-backups/cron.log 2>&1'
		);
	});

	it('keeps the rest of the crontab and replaces only its own block', () => {
		const mine = '# mine\n*/5 * * * * echo hi\n';
		const first = replaceCronBlock(mine, [{ id: 'a', schedule: '0 3 * * *' }], RUN);
		expect(first.startsWith(mine)).toBe(true);
		expect(first).toContain('tracked run a');
		expect(first.endsWith('\n')).toBe(true);

		const second = replaceCronBlock(first, [{ id: 'b', schedule: '@hourly' }], RUN);
		expect(second).not.toContain('tracked run a');
		expect(second).toContain('@hourly');
		expect(second.match(/>>> tgb/g)).toHaveLength(1);

		expect(replaceCronBlock(second, [], RUN)).toBe(mine);
	});

	it('leaves the blocks of other data folders alone', () => {
		const other = replaceCronBlock('', [{ id: 'x', schedule: '@daily' }], {
			...RUN,
			dataRoot: '/other'
		});
		const both = replaceCronBlock(other, [{ id: 'y', schedule: '@daily' }], RUN);
		expect(both).toContain('tracked run x');
		expect(both).toContain('tracked run y');
		expect(replaceCronBlock(both, [], RUN)).toBe(other);
	});
});

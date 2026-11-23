// The block of the user's crontab that tgb owns. Everything outside it is left alone.

export interface CronJob {
	id: string;
	schedule: string;
}

export interface CronInvocation {
	/** The node binary, absolute: cron's PATH rarely has it. */
	node: string;
	/** The bundled `tgb` script, absolute. */
	script: string;
	dataRoot: string;
	logFile: string;
}

/** For /bin/sh. */
export function shellQuote(value: string): string {
	return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function markers(dataRoot: string) {
	return {
		start: `# >>> tgb tracked backups (${dataRoot}) >>>`,
		end: `# <<< tgb tracked backups (${dataRoot}) <<<`
	};
}

/** One crontab line. Cron turns an unescaped `%` into a newline, so they are escaped. */
export function cronLine(job: CronJob, run: CronInvocation): string {
	const command = [run.node, run.script, '--data-dir', run.dataRoot, 'tracked', 'run', job.id].map(
		shellQuote
	);
	const line = `${job.schedule} ${command.join(' ')} >> ${shellQuote(run.logFile)} 2>&1`;
	return line.replace(/%/g, '\\%');
}

/**
 * The crontab with tgb's block for this data root replaced by these jobs, at
 * the end. No jobs removes the block.
 */
export function replaceCronBlock(existing: string, jobs: CronJob[], run: CronInvocation): string {
	const { start, end } = markers(run.dataRoot);
	const kept: string[] = [];
	let inside = false;
	for (const line of existing.split('\n')) {
		if (line === start) inside = true;
		else if (line === end) inside = false;
		else if (!inside) kept.push(line);
	}
	while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();

	if (jobs.length > 0) {
		if (kept.length > 0) kept.push('');
		kept.push(start, '# Managed by tgb. Change it with `tgb tracked`, not by hand.');
		for (const job of jobs) kept.push(cronLine(job, run));
		kept.push(end);
	}
	// Cron ignores a last line without a newline.
	return kept.length === 0 ? '' : `${kept.join('\n')}\n`;
}

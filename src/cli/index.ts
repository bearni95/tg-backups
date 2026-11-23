// The `tgb` binary.
import { loadDotenv } from '$lib/env';
import { describeError, log } from '$lib/logger';
import { createProgram } from './program';

// Before anything reads its settings from the environment.
loadDotenv();

// One failed background call mustn't take down a running transfer.
process.on('unhandledRejection', (reason) =>
	log.error(`unhandled rejection: ${describeError(reason)}`)
);

createProgram()
	.parseAsync()
	.then(
		// An idle mtcute timer can outlive the client, so don't wait for the event loop to drain.
		// Once stdout has flushed, so piped output isn't cut short.
		() => process.stdout.write('', () => process.exit()),
		(error) => {
			log.error(describeError(error));
			process.exit(1);
		}
	);

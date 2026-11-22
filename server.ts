// `pnpm start`: the built app on loopback. Runs on Node's type stripping.
import { loadDotenv } from './src/lib/server/env.ts';
import { createAppServer, parsePort } from './src/lib/server/http/node-server.ts';
import { describeError, log } from './src/lib/server/logger.ts';

async function main(): Promise<void> {
	// Before the handler loads: the backend reads its settings from the environment.
	loadDotenv();
	const port = parsePort(process.env.TGB_PORT);
	// adapter-node reads this on import and otherwise rejects bodies over 512 KB.
	process.env.BODY_SIZE_LIMIT = 'Infinity';

	// One failed background call mustn't take down every running transfer.
	process.on('unhandledRejection', (reason) =>
		log.error(`unhandled rejection: ${describeError(reason)}`)
	);

	const { handler } = await import(new URL('./dist/handler.js', import.meta.url).href);
	const server = createAppServer(handler);
	server.on('error', (error) => {
		log.error(`cannot listen on 127.0.0.1:${port}: ${error.message}`);
		process.exit(1);
	});
	server.listen(port, '127.0.0.1', () => log.info(`listening on http://localhost:${port}`));
}

main().catch((error) => {
	log.error(describeError(error));
	process.exit(1);
});

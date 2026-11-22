import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import { allowLongRequests, localOnly } from './src/lib/server/http/node-server.ts';

/** The dev and preview servers get the same guard and timeouts as server.ts. */
const localBackend: Plugin = {
	name: 'tgb-local-backend',
	configureServer(server) {
		if (server.httpServer) allowLongRequests(server.httpServer);
		server.middlewares.use(localOnly);
	},
	configurePreviewServer(server) {
		allowLongRequests(server.httpServer);
		server.middlewares.use(localOnly);
	}
};

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig(({ command }) => ({
	plugins: [localBackend, tailwindcss(), sveltekit()],
	define: {
		__TGB_VERSION__: JSON.stringify(version),
		// Build only: the dev server hands every define to the browser.
		...(command === 'build' && {
			__TGB_API_ID__: JSON.stringify(process.env.TELEGRAM_API_ID ?? ''),
			__TGB_API_HASH__: JSON.stringify(process.env.TELEGRAM_API_HASH ?? '')
		})
	}
}));

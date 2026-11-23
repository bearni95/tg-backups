import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// One file, dist/cli.js. Dependencies stay external and load from node_modules.
export default defineConfig({
	entry: { cli: 'src/cli/index.ts' },
	format: 'esm',
	platform: 'node',
	target: 'node24',
	outDir: 'dist',
	clean: true,
	// `node:sqlite` only exists with the prefix.
	removeNodeProtocol: false,
	banner: { js: '#!/usr/bin/env node' },
	define: {
		__TGB_VERSION__: JSON.stringify(version),
		// The last fallback for credentials, after credentials.json and the environment.
		__TGB_API_ID__: JSON.stringify(process.env.TELEGRAM_API_ID ?? ''),
		__TGB_API_HASH__: JSON.stringify(process.env.TELEGRAM_API_HASH ?? '')
	}
});

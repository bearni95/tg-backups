import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
		// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
		// See https://svelte.dev/docs/kit/adapters for more information about adapters.
		// server.ts serves dist/handler.js. Zips don't compress, so neither does the app.
		adapter: adapter({ out: 'dist', precompress: false }),
		// Kit compares Origin with an https URL it infers, which rejects uploads over
		// plain http. hooks.server.ts and server.ts require the app's own origin instead.
		csrf: { trustedOrigins: ['*'] },
		typescript: {
			config: (tsconfig) => ({ ...tsconfig, include: [...tsconfig.include, '../server.ts'] })
		},
		alias: {
			$components: 'src/components/*',
			$utils: 'src/utils/*',
			$types: 'src/types/*',
			$data: 'src/data/*',
			$adapters: 'src/adapters/*',
			$services: 'src/services/*'
		}
	}
};

export default config;

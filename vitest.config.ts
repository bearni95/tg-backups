import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const src = (path: string) => resolve(import.meta.dirname, 'src', path);

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./test/setup.ts'],
		include: ['test/**/*.{test,spec}.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html'],
			exclude: ['node_modules/', 'test/', '**/*.d.ts', '**/*.config.*', 'dist/']
		}
	},
	resolve: {
		alias: {
			$lib: src('lib'),
			$adapters: src('adapters'),
			$types: src('types'),
			$utils: src('utils')
		}
	}
});

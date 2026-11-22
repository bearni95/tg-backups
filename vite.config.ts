import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const BACKEND = `http://127.0.0.1:${process.env.TGB_PORT || 9811}`;

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	// A plain object (not the string shorthand) keeps the Host header for the backend's local-only guard.
	server: { proxy: { '/api': { target: BACKEND } } },
	preview: { proxy: { '/api': { target: BACKEND } } }
});

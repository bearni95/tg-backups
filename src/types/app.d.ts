// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { TelegramStorage } from '../lib/server/telegram/storage';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Set by hooks.server.ts on /api/telegram requests. */
			telegram: TelegramStorage;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};

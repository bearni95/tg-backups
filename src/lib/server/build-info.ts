// Replaced by `define` in vite.config.ts during `vite build`. Never import from client code.
declare const __TGB_VERSION__: string;
declare const __TGB_API_ID__: string;
declare const __TGB_API_HASH__: string;

export const APP_VERSION = typeof __TGB_VERSION__ === 'string' ? __TGB_VERSION__ : '0.0.0';

/** Credentials present in the environment at build time: the last fallback. */
export const EMBEDDED_API_ID = typeof __TGB_API_ID__ === 'string' ? __TGB_API_ID__ : '';
export const EMBEDDED_API_HASH = typeof __TGB_API_HASH__ === 'string' ? __TGB_API_HASH__ : '';

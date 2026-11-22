// The API has no auth of its own and hands out the Telegram session, so it only
// answers this machine. The bind keeps the LAN out; Host stops DNS rebinding and
// Origin stops other websites.
const HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;
const ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

export function hasLocalHeaders(
	host: string | null | undefined,
	origin: string | null | undefined
): boolean {
	if (!host || !HOST.test(host)) return false;
	return origin === null || origin === undefined || ORIGIN.test(origin);
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
	if (!address) return false;
	return address === '::1' || /^(?:::ffff:)?127\.\d+\.\d+\.\d+$/.test(address);
}

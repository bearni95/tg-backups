// The API has no auth of its own and hands out the Telegram session, so it only
// answers this machine and, in a browser, only its own page. The bind keeps the
// LAN out and Host stops DNS rebinding. Other localhost ports are other apps:
// loopback is not enough, the origin has to be this exact one.
const HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

/**
 * Whether a request is the app's own, or no browser's at all (curl, scripts).
 *
 * `Origin` covers writes. `Sec-Fetch-Site` covers what is sent without one, like
 * images and frames. The one thing another site may do is link to the app's page.
 */
export function isTrustedRequest(
	method: string | undefined,
	path: string | undefined,
	header: (name: string) => string | null | undefined
): boolean {
	const host = header('host');
	if (!host || !HOST.test(host)) return false;

	const origin = header('origin') ?? null;
	if (origin !== null && origin !== `http://${host}`) return false;

	const site = header('sec-fetch-site') ?? null;
	if (site === null || site === 'same-origin' || site === 'none') return true;

	return (
		method === 'GET' &&
		path?.split('?')[0] === '/' &&
		header('sec-fetch-mode') === 'navigate' &&
		// Not a frame, where another page could trick clicks out of the user.
		header('sec-fetch-dest') === 'document'
	);
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
	if (!address) return false;
	return address === '::1' || /^(?:::ffff:)?127\.\d+\.\d+\.\d+$/.test(address);
}

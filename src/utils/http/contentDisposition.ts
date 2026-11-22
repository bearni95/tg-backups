/** Replace what would break out of a quoted header value. */
export function sanitiseFilename(name: string): string {
	return name.replace(/["\\\r\n]/g, '_');
}

/**
 * `attachment` with the file's name. Header values must be Latin-1, so other
 * names get an ASCII fallback plus the RFC 5987 UTF-8 form.
 */
export function attachmentDisposition(name: string): string {
	const safe = sanitiseFilename(name);
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x08\x0a-\x1f\x7f]/.test(safe)) return 'attachment';
	if (/^[\t\x20-\x7e]*$/.test(safe)) return `attachment; filename="${safe}"`;

	const fallback = safe.replace(/[^\t\x20-\x7e]/gu, '_');
	const encoded = encodeURIComponent(safe.toWellFormed()).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
	);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

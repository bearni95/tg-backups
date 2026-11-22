/** What browsers and extension lookups report for a zip, plus their generic fallbacks. */
export const ZIP_MIME_TYPES: readonly string[] = [
	'application/zip',
	'application/x-zip',
	'application/x-zip-compressed',
	'application/x-compressed',
	'multipart/x-zip',
	'application/octet-stream',
	''
];

/**
 * The group stores backups, so only zips get in. The extension is required so
 * a restored file always opens as an archive.
 */
export function isAllowedBackup(name: string, mimeType: string): boolean {
	const dot = name.lastIndexOf('.');
	return (
		dot > 0 &&
		/^zip$/i.test(name.slice(dot + 1)) &&
		ZIP_MIME_TYPES.includes(mimeType.trim().toLowerCase())
	);
}

// The chunk engine treats (name, size) as one logical file, both when it resumes
// and when it rebuilds the index from the group. Backups break that: `db.zip` is
// uploaded again and again with other bytes and sometimes the same size. So the
// stored name carries a fingerprint of the content, and the API hides it again.
const TAG = '.tgb-';
const FINGERPRINT_LENGTH = 12;
const FINGERPRINT = new RegExp(`^[0-9a-fA-F]{${FINGERPRINT_LENGTH}}$`);

/** `db.zip` + digest → `db.tgb-<fingerprint>.zip`. */
export function storedName(name: string, sha256Hex: string): string {
	const dot = name.lastIndexOf('.');
	const stem = dot < 0 ? name : name.slice(0, dot);
	const ext = dot < 0 ? 'zip' : name.slice(dot + 1);
	return `${stem}${TAG}${sha256Hex.slice(0, FINGERPRINT_LENGTH)}.${ext}`;
}

/** Inverse of {@link storedName}. Names without a fingerprint pass through. */
export function originalName(stored: string): string {
	const dot = stored.lastIndexOf('.');
	if (dot < 0) return stored;
	const head = stored.slice(0, dot);
	const tag = head.lastIndexOf(TAG);
	if (tag < 0 || !FINGERPRINT.test(head.slice(tag + TAG.length))) return stored;
	return `${head.slice(0, tag)}${stored.slice(dot)}`;
}

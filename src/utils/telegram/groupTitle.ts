/** Backup groups are told apart from the account's other chats by this, case included. */
export const GROUP_PREFIX = 'TGB-';

export function hasGroupPrefix(title: string): boolean {
	return title.startsWith(GROUP_PREFIX);
}

/** What follows the prefix, whether or not it was typed. */
export function groupName(input: string): string {
	const name = input.trim();
	return hasGroupPrefix(name) ? name.slice(GROUP_PREFIX.length).trim() : name;
}

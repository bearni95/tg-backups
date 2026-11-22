import { join } from 'node:path';

export function telegramDir(dataRoot: string): string {
	return join(dataRoot, 'telegram');
}

/** JSON, not SQLite: the name predates the format and is kept so sessions carry over. */
export function sessionPath(dataRoot: string): string {
	return join(telegramDir(dataRoot), 'session.sqlite');
}

export function credentialsPath(dataRoot: string): string {
	return join(telegramDir(dataRoot), 'credentials.json');
}

export function groupsPath(dataRoot: string): string {
	return join(telegramDir(dataRoot), 'groups.json');
}

export function groupsDir(dataRoot: string): string {
	return join(telegramDir(dataRoot), 'groups');
}

/** Per account too: outside channels, message ids are per account. */
export function groupIndexPath(dataRoot: string, userId: number, groupId: string): string {
	return join(groupsDir(dataRoot), String(userId), `${groupId}.sqlite`);
}

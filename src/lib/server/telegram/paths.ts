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

export function indexPath(dataRoot: string): string {
	return join(telegramDir(dataRoot), 'index.sqlite');
}

export function accessKeyPath(dataRoot: string): string {
	return join(telegramDir(dataRoot), 'access_cookie.key');
}

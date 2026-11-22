import type {
	TelegramAuthOutcome,
	TelegramCredentials,
	TelegramFile,
	TelegramGroup,
	TelegramGroupInfo,
	TelegramQrStep,
	TelegramStatus,
	TelegramUploadSnapshot
} from '$types/telegram.type';
import { jsonFetch, type StartUploadInput, type TelegramSource } from './telegram-source';

function inGroup(path: string, groupId: string): string {
	return `${path}?group=${encodeURIComponent(groupId)}`;
}

/** The SvelteKit backend (`src/routes/api/telegram`) over `/api/telegram/*`. */
export class ApiTelegramSource implements TelegramSource {
	getStatus(): Promise<TelegramStatus> {
		return jsonFetch<TelegramStatus>('/api/telegram/status');
	}

	getCredentials(): Promise<TelegramCredentials> {
		return jsonFetch<TelegramCredentials>('/api/telegram/credentials');
	}

	async setCredentials(apiId: number, apiHash: string): Promise<void> {
		await jsonFetch<unknown>('/api/telegram/credentials', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ apiId, apiHash })
		});
	}

	async deleteCredentials(): Promise<void> {
		await jsonFetch<unknown>('/api/telegram/credentials', { method: 'DELETE' });
	}

	async startAuth(phone: string): Promise<void> {
		await jsonFetch<unknown>('/api/telegram/auth/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ phone })
		});
	}

	async resendCode(): Promise<void> {
		await jsonFetch<unknown>('/api/telegram/auth/resend', { method: 'POST' });
	}

	qrLoginStep(): Promise<TelegramQrStep> {
		return jsonFetch<TelegramQrStep>('/api/telegram/auth/qr', { method: 'POST' });
	}

	submitCode(code: string): Promise<TelegramAuthOutcome> {
		return jsonFetch<TelegramAuthOutcome>('/api/telegram/auth/code', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ code })
		});
	}

	submitPassword(password: string): Promise<TelegramAuthOutcome> {
		return jsonFetch<TelegramAuthOutcome>('/api/telegram/auth/password', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ password })
		});
	}

	async logout(): Promise<void> {
		await jsonFetch<unknown>('/api/telegram/auth/logout', { method: 'POST' });
	}

	async createGroup(title: string): Promise<TelegramGroup> {
		const data = await jsonFetch<{ group: TelegramGroup }>('/api/telegram/groups', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title })
		});
		return data.group;
	}

	async listAvailableGroups(): Promise<TelegramGroup[]> {
		const data = await jsonFetch<{ groups: TelegramGroup[] }>('/api/telegram/groups/available');
		return data.groups;
	}

	async selectGroup(id: string): Promise<TelegramGroup> {
		const data = await jsonFetch<{ group: TelegramGroup }>('/api/telegram/groups/select', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id })
		});
		return data.group;
	}

	getGroupInfo(id: string): Promise<TelegramGroupInfo> {
		return jsonFetch<TelegramGroupInfo>(`/api/telegram/groups/${encodeURIComponent(id)}`);
	}

	async listFiles(groupId: string): Promise<TelegramFile[]> {
		const data = await jsonFetch<{ files: TelegramFile[] }>(
			inGroup('/api/telegram/files', groupId)
		);
		return data.files;
	}

	async scanMetadata(groupId: string): Promise<TelegramFile[]> {
		const data = await jsonFetch<{ files: TelegramFile[] }>(
			`${inGroup('/api/telegram/files', groupId)}&scope=metadata`
		);
		return data.files;
	}

	loadMediaForPipeline(pipelineId: string, groupId: string): Promise<TelegramFile> {
		return jsonFetch<TelegramFile>(
			inGroup(`/api/telegram/files/load-media/${encodeURIComponent(pipelineId)}`, groupId),
			{ method: 'POST' }
		);
	}

	async uploadFile(file: File, groupId: string): Promise<void> {
		const body = new FormData();
		body.append('name', file.name);
		body.append('size', String(file.size));
		body.append('file', file, file.name);
		await jsonFetch<unknown>(inGroup('/api/telegram/files', groupId), { method: 'POST', body });
	}

	async deleteFile(id: string, groupId: string): Promise<void> {
		await jsonFetch<unknown>(inGroup(`/api/telegram/files/${encodeURIComponent(id)}`, groupId), {
			method: 'DELETE'
		});
	}

	async deleteAllFiles(groupId: string): Promise<void> {
		await jsonFetch<unknown>('/api/telegram/files/delete-all', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ groupId })
		});
	}

	downloadUrl(id: string, groupId: string): string {
		return inGroup(`/api/telegram/files/${encodeURIComponent(id)}`, groupId);
	}

	async startUpload(input: StartUploadInput, groupId: string): Promise<TelegramUploadSnapshot> {
		const body = await jsonFetch<{ uploadId: string; snapshot: TelegramUploadSnapshot }>(
			inGroup('/api/telegram/uploads', groupId),
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					path: input.path,
					name: input.name,
					mimeType: input.mimeType,
					metadata: input.metadata,
					refId: input.refId
				})
			}
		);
		return body.snapshot;
	}

	async listUploads(): Promise<TelegramUploadSnapshot[]> {
		const data = await jsonFetch<{ uploads: TelegramUploadSnapshot[] }>('/api/telegram/uploads');
		return data.uploads;
	}

	async pauseUpload(uploadId: string): Promise<void> {
		await jsonFetch<TelegramUploadSnapshot>(
			`/api/telegram/uploads/${encodeURIComponent(uploadId)}/pause`,
			{ method: 'POST' }
		);
	}

	async resumeUpload(uploadId: string): Promise<void> {
		await jsonFetch<TelegramUploadSnapshot>(
			`/api/telegram/uploads/${encodeURIComponent(uploadId)}/resume`,
			{ method: 'POST' }
		);
	}

	async cancelUpload(uploadId: string): Promise<void> {
		await jsonFetch<unknown>(`/api/telegram/uploads/${encodeURIComponent(uploadId)}`, {
			method: 'DELETE'
		});
	}
}

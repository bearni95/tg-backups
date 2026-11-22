import type {
	TelegramAuthOutcome,
	TelegramCredentials,
	TelegramFile,
	TelegramQrStep,
	TelegramStatus,
	TelegramUploadSnapshot
} from '$types/telegram.type';
import { jsonFetch, type StartUploadInput, type TelegramSource } from './telegram-source';

/** The Rust backend (`packages/backend`) over `/api/telegram/*`. */
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

	async recheckAccess(): Promise<void> {
		await jsonFetch<unknown>('/api/telegram/access/recheck', { method: 'POST' });
	}

	async listFiles(): Promise<TelegramFile[]> {
		const data = await jsonFetch<{ files: TelegramFile[] }>('/api/telegram/files');
		return data.files;
	}

	async scanMetadata(): Promise<TelegramFile[]> {
		const data = await jsonFetch<{ files: TelegramFile[] }>('/api/telegram/files?scope=metadata');
		return data.files;
	}

	loadMediaForPipeline(pipelineId: string): Promise<TelegramFile> {
		return jsonFetch<TelegramFile>(
			`/api/telegram/files/load-media/${encodeURIComponent(pipelineId)}`,
			{ method: 'POST' }
		);
	}

	async uploadFile(file: File): Promise<void> {
		const body = new FormData();
		body.append('name', file.name);
		body.append('size', String(file.size));
		body.append('file', file, file.name);
		await jsonFetch<unknown>('/api/telegram/files', { method: 'POST', body });
	}

	async deleteFile(id: string): Promise<void> {
		await jsonFetch<unknown>(`/api/telegram/files/${encodeURIComponent(id)}`, {
			method: 'DELETE'
		});
	}

	async deleteAllFiles(): Promise<void> {
		await jsonFetch<unknown>('/api/telegram/files/delete-all', { method: 'POST' });
	}

	downloadUrl(id: string): string {
		return `/api/telegram/files/${encodeURIComponent(id)}`;
	}

	async startUpload(input: StartUploadInput): Promise<TelegramUploadSnapshot> {
		const body = await jsonFetch<{ uploadId: string; snapshot: TelegramUploadSnapshot }>(
			'/api/telegram/uploads',
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

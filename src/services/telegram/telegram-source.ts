import type {
	TelegramAuthOutcome,
	TelegramCredentials,
	TelegramFile,
	TelegramQrStep,
	TelegramStatus,
	TelegramUploadSnapshot
} from '$types/telegram.type';

/**
 * The data backend the Telegram service talks to, implemented by
 * `ApiTelegramSource` over `/api/telegram/*`. The service keeps all the
 * orchestration (poll timers, stores, error surfacing) and only delegates the
 * transport. A method MAY throw {@link TelegramApiError}.
 */
export interface TelegramSource {
	getStatus(): Promise<TelegramStatus>;
	/** Throws {@link TelegramApiError} with `code === 'credentials_missing'`
	 * when no credentials are configured — the service maps that to `null`. */
	getCredentials(): Promise<TelegramCredentials>;
	setCredentials(apiId: number, apiHash: string): Promise<void>;
	deleteCredentials(): Promise<void>;
	startAuth(phone: string): Promise<void>;
	/** Ask Telegram to deliver the pending login code again. */
	resendCode(): Promise<void>;
	/** One QR-code login poll (pending QR, or the finished login). */
	qrLoginStep(): Promise<TelegramQrStep>;
	submitCode(code: string): Promise<TelegramAuthOutcome>;
	submitPassword(password: string): Promise<TelegramAuthOutcome>;
	logout(): Promise<void>;
	recheckAccess(): Promise<void>;
	/** Full media file list. The service sets its `files` store from this. */
	listFiles(): Promise<TelegramFile[]>;
	/** Metadata-sidecar-only listing (the catalog fast path). */
	scanMetadata(): Promise<TelegramFile[]>;
	/** Single attempt to mint/return the media row for a pipeline id. The
	 * service wraps this with the 404 retry/backoff loop. */
	loadMediaForPipeline(pipelineId: string): Promise<TelegramFile>;
	uploadFile(file: File): Promise<void>;
	deleteFile(id: string): Promise<void>;
	deleteAllFiles(): Promise<void>;
	/** Synchronous — used directly as a download link `href`. */
	downloadUrl(id: string): string;
	startUpload(input: StartUploadInput): Promise<TelegramUploadSnapshot>;
	listUploads(): Promise<TelegramUploadSnapshot[]>;
	pauseUpload(uploadId: string): Promise<void>;
	resumeUpload(uploadId: string): Promise<void>;
	cancelUpload(uploadId: string): Promise<void>;
}

export interface StartUploadInput {
	path: string;
	name?: string;
	mimeType?: string;
	metadata?: unknown;
	refId?: string;
}

export interface ApiErrorBody {
	error?: string;
	code?: string;
	retryAfterSeconds?: number;
	limitBytes?: number;
}

export class TelegramApiError extends Error {
	code: string;
	status: number;
	retryAfterSeconds?: number;
	limitBytes?: number;

	constructor(status: number, body: ApiErrorBody) {
		super(body.error || `telegram api error (${status})`);
		this.name = 'TelegramApiError';
		this.code = body.code || 'unknown';
		this.status = status;
		this.retryAfterSeconds = body.retryAfterSeconds;
		this.limitBytes = body.limitBytes;
	}
}

export async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
	const res = await fetch(input, init);
	if (!res.ok) {
		let body: ApiErrorBody = {};
		try {
			body = (await res.json()) as ApiErrorBody;
		} catch {
			body = { error: res.statusText };
		}
		throw new TelegramApiError(res.status, body);
	}
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
}

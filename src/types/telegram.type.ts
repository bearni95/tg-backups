export type TelegramLoginStage = 'awaiting_code' | 'awaiting_password';

/** How Telegram delivered a login code (see telegram-auth.adapter.ts). */
export type TelegramCodeMethod =
	| 'app'
	| 'sms'
	| 'call'
	| 'flash_call'
	| 'missed_call'
	| 'email'
	| 'setup_email_required'
	| 'fragment_sms'
	| 'firebase_sms'
	| 'sms_word'
	| 'sms_phrase';

/** Where the pending login code went, so the UI can tell the user where to look. */
export interface TelegramCodeDelivery {
	method: TelegramCodeMethod;
	length: number | null;
	/** Masked address the code was emailed to (`method === 'email'`). */
	emailPattern: string | null;
	/** Method a resend will use; null when Telegram offers no resend. */
	nextMethod: TelegramCodeMethod | null;
	/** Seconds before a resend is allowed. */
	timeoutSecs: number | null;
}

export interface TelegramUser {
	id: number;
	firstName: string | null;
	lastName: string | null;
	username: string | null;
	phone: string | null;
}

export interface TelegramStatus {
	hasCredentials: boolean;
	connected: boolean;
	/** Signed in to Telegram (valid session), regardless of group membership. */
	signedIn: boolean;
	/** Fully cleared to use the app: signed in and (when gating is enabled) a
	 * member of the required Telegram group. */
	authorized: boolean;
	/** Signed in but not a member of the required group — the gate shows the
	 * "ask an admin to add you" screen. */
	accessDenied: boolean;
	/** Whether this deployment gates login on membership of the shared Telegram
	 * group at all (`TGB_TELEGRAM_ACCESS_GROUP` set). Lets the login UI show
	 * the requirement up front — before sign-in — not just after a denial. */
	accessGroupRequired: boolean;
	/** A shareable `https://t.me/…` link for the required group, so the UI can
	 * render a join link + QR code for non-members. Null when gating is disabled
	 * or the spec is a bare numeric id with no public link. */
	accessGroupInvite: string | null;
	loginInProgress: TelegramLoginStage | null;
	/** Where the pending code went; set only while `loginInProgress === 'awaiting_code'`. */
	codeDelivery: TelegramCodeDelivery | null;
	user: TelegramUser | null;
}

export interface TelegramCredentials {
	apiId: number;
	apiHash: string;
}

export interface TelegramFile {
	id: string;
	name: string;
	sizeBytes: number;
	/** Every byte is on Telegram. Only complete backups can be restored. */
	complete: boolean;
	mimeType: string;
	createdAt: string;
	text?: string;
	checksumSha256?: string;
	metadata?: unknown;
}

export type TelegramAuthOutcome =
	| { outcome: 'authenticated'; user: TelegramUser }
	| { outcome: 'passwordRequired'; hint: string | null };

/** A pending QR-code login: `url` is the `tg://login?token=…` to render as a QR. */
export interface TelegramQrPending {
	outcome: 'pending';
	url: string;
	/** Unix seconds when this token expires (the backend hands out a new one after). */
	expiresAt: number;
}

/** One poll of `POST /api/telegram/auth/qr`. */
export type TelegramQrStep = TelegramQrPending | TelegramAuthOutcome;

export interface TelegramApiError {
	error: string;
	code: string;
	retryAfterSeconds?: number;
	limitBytes?: number;
}

export type TelegramUploadStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type TelegramChunkStatus = 'pending' | 'running' | 'done';

export interface TelegramChunkSnapshot {
	index: number;
	bytesUploaded: number;
	bytesTotal: number;
	status: TelegramChunkStatus;
}

export interface TelegramUploadSnapshot {
	uploadId: string;
	refId: string;
	name: string;
	status: TelegramUploadStatus;
	bytesUploaded: number;
	/** Subset of `bytesUploaded` credited from chunks that were already on
	 * Telegram and seek-skipped on resume — they never went over the wire.
	 * Subtract from `bytesUploaded` before dividing by the transfer window
	 * for speed / ETA, so a resume's instantly-credited chunks don't inflate
	 * the rate. Always 0 for a fresh upload. */
	skippedBytes: number;
	totalBytes: number;
	chunksCompleted: number;
	totalChunks: number;
	fileId: string | null;
	error: string | null;
	/** Unix seconds when the upload was enqueued. Can predate the actual
	 * transfer by however long it waited in the upload queue — do NOT use it
	 * for speed / ETA math (that inflates the ETA); use `transferStartedAt`. */
	startedAt: number;
	/** Unix seconds when the byte transfer actually began (the upload
	 * acquired the queue gate). `null` while still queued behind other
	 * uploads. Speed / ETA are measured from here. */
	transferStartedAt: number | null;
	finishedAt: number | null;
	chunks: TelegramChunkSnapshot[];
}

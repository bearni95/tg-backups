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

/** Where the pending login code went, so the CLI can tell the user where to look. */
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
	/** Signed in, with the account known: groups are per account. */
	authorized: boolean;
	loginInProgress: TelegramLoginStage | null;
	/** Where the pending code went; set only while `loginInProgress === 'awaiting_code'`. */
	codeDelivery: TelegramCodeDelivery | null;
	user: TelegramUser | null;
	/** The groups this account stores backups in. */
	groups: TelegramGroup[];
	/** Null until one is created or chosen. */
	activeGroupId: string | null;
}

export interface TelegramGroup {
	/** `channel-<id>` or `chat-<id>`. */
	id: string;
	title: string;
}

export interface TelegramGroupInfo extends TelegramGroup {
	/** Null when this account can't share one. */
	invite: string | null;
	/** Set when the group deletes its messages, backups included. */
	autoDeleteSeconds: number | null;
	/** New members can't see the backups already there. */
	historyHidden: boolean;
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
	/** Unix seconds when this token expires (the next poll gets a new one after). */
	expiresAt: number;
}

/** One poll of the QR login. */
export type TelegramQrStep = TelegramQrPending | TelegramAuthOutcome;

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
	/** Where it is going, whichever group is selected now. */
	groupId: string;
	groupTitle: string;
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

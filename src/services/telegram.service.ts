import { browser } from '$app/environment';
import { get, writable, type Writable } from 'svelte/store';
import localStorageWritableStore from '$utils/localStorageWritableStore';
import type {
	TelegramAuthOutcome,
	TelegramCredentials,
	TelegramFile,
	TelegramGroup,
	TelegramGroupInfo,
	TelegramQrPending,
	TelegramStatus,
	TelegramUploadSnapshot
} from '$types/telegram.type';
import { TelegramApiError } from './telegram/telegram-source';
import { telegramSource } from './telegram/create-telegram-source';

// Re-export so existing importers (components, tests) keep resolving
// `TelegramApiError` from `$services/telegram.service`.
export { TelegramApiError };

const STATUS_POLL_MS = 5000;
const UPLOADS_POLL_MS = 1000;
const QR_POLL_MS = 3000;

// A local "authorized until" hint, so a reload within the window opens the UI
// instantly instead of flashing the gate while the first /status round-trips.
// Purely a rendering optimisation: the status is what decides.
const AUTH_HINT_KEY = 'telegram:authorized-until';
const AUTH_HINT_TTL_MS = 60 * 60 * 1000;

class TelegramService {
	status: Writable<TelegramStatus | null> = writable(null);
	files: Writable<TelegramFile[]> = writable([]);
	uploads: Writable<TelegramUploadSnapshot[]> = writable([]);
	loadingStatus: Writable<boolean> = writable(false);
	loadingFiles: Writable<boolean> = writable(false);
	lastError: Writable<string | null> = writable(null);
	/// `true` when a still-valid local "authorized until" hint survives from a
	/// previous load — lets `TelegramLoginGate` open immediately on reload
	/// (before the first `/status` poll resolves) without flashing the gate.
	optimisticAuthorized: Writable<boolean> = writable(false);
	/// The QR currently shown for QR-code login; `null` when QR login isn't running.
	qrLogin: Writable<TelegramQrPending | null> = writable(null);

	groupInfo: Writable<TelegramGroupInfo | null> = writable(null);
	/// The groups "use an existing group" offers; `null` until loaded.
	availableGroups: Writable<TelegramGroup[] | null> = writable(null);
	loadingGroups: Writable<boolean> = writable(false);

	// Responses can arrive out of order, and a late one mustn't show another group's data.
	private statusSeq = 0;
	private appliedStatusSeq = 0;
	private filesSeq = 0;
	private authorizedUntil = localStorageWritableStore<number>(AUTH_HINT_KEY, 0);
	private qrTimer: ReturnType<typeof setTimeout> | null = null;
	private qrActive = false;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private uploadsPollTimer: ReturnType<typeof setInterval> | null = null;
	private uploadsWatchers = 0;
	private started = false;

	constructor() {
		// Seed the optimistic flag once at startup from the persisted hint, so
		// the very first render can open the gate. Subsequent `/status` polls
		// are authoritative and drive the gate via `status.authorized`.
		this.optimisticAuthorized.set(browser && get(this.authorizedUntil) > Date.now());
	}

	start(): void {
		if (this.started || !browser) return;
		this.started = true;
		void this.refreshStatus();
		this.pollTimer = setInterval(() => {
			void this.refreshStatus();
		}, STATUS_POLL_MS);
	}

	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		this.started = false;
	}

	clearError(): void {
		this.lastError.set(null);
	}

	async refreshStatus(): Promise<void> {
		this.loadingStatus.set(true);
		const seq = ++this.statusSeq;
		try {
			const data = await telegramSource.getStatus();
			if (seq < this.appliedStatusSeq) return;
			this.appliedStatusSeq = seq;
			const previous = get(this.status);
			if ((previous?.activeGroupId ?? null) !== (data?.activeGroupId ?? null)) {
				this.clearGroupView();
			}
			if (previous?.authorized && !data?.authorized) this.availableGroups.set(null);
			this.status.set(data);
			// Refresh (or clear) the local hint for the *next* page load. The
			// in-session gate is driven by `status.authorized` directly.
			this.authorizedUntil.set(data.authorized ? Date.now() + AUTH_HINT_TTL_MS : 0);
		} catch (err) {
			this.handleError(err);
		} finally {
			this.loadingStatus.set(false);
		}
	}

	async getCredentials(): Promise<TelegramCredentials | null> {
		try {
			return await telegramSource.getCredentials();
		} catch (err) {
			if (err instanceof TelegramApiError && err.code === 'credentials_missing') {
				return null;
			}
			this.handleError(err);
			throw err;
		}
	}

	async setCredentials(apiId: number, apiHash: string): Promise<void> {
		await telegramSource.setCredentials(apiId, apiHash);
		await this.refreshStatus();
	}

	async deleteCredentials(): Promise<void> {
		await telegramSource.deleteCredentials();
		this.files.set([]);
		await this.refreshStatus();
	}

	/// Errors land in `lastError` (shown by the login UI) instead of rejecting,
	/// so a failed code request is never silent.
	async startAuth(phone: string): Promise<void> {
		this.clearError();
		try {
			await telegramSource.startAuth(phone);
		} catch (err) {
			this.handleError(err);
		}
		await this.refreshStatus();
	}

	/// Start QR-code login: poll the backend, keeping `qrLogin` on the latest
	/// QR, until the user approves it from Telegram on their phone (then the
	/// login finishes, or the gate moves on to the 2FA password) or it fails.
	startQrLogin(): void {
		if (this.qrActive) return;
		this.qrActive = true;
		this.clearError();
		void this.pollQrLogin();
	}

	stopQrLogin(): void {
		this.qrActive = false;
		if (this.qrTimer) {
			clearTimeout(this.qrTimer);
			this.qrTimer = null;
		}
		this.qrLogin.set(null);
	}

	private async pollQrLogin(): Promise<void> {
		if (!this.qrActive) return;
		try {
			const step = await telegramSource.qrLoginStep();
			if (!this.qrActive) return;
			if (step.outcome === 'pending') {
				this.qrLogin.set(step);
				this.qrTimer = setTimeout(() => void this.pollQrLogin(), QR_POLL_MS);
				return;
			}
			this.stopQrLogin();
			await this.refreshStatus();
			if (step.outcome === 'authenticated') {
				await this.refreshFiles();
			}
		} catch (err) {
			this.stopQrLogin();
			this.handleError(err);
		}
	}

	async resendCode(): Promise<void> {
		this.clearError();
		try {
			await telegramSource.resendCode();
		} catch (err) {
			this.handleError(err);
		}
		await this.refreshStatus();
	}

	async submitCode(code: string): Promise<TelegramAuthOutcome> {
		const outcome = await telegramSource.submitCode(code);
		await this.refreshStatus();
		if (outcome.outcome === 'authenticated') {
			await this.refreshFiles();
		}
		return outcome;
	}

	async submitPassword(password: string): Promise<TelegramAuthOutcome> {
		const outcome = await telegramSource.submitPassword(password);
		await this.refreshStatus();
		if (outcome.outcome === 'authenticated') {
			await this.refreshFiles();
		}
		return outcome;
	}

	async logout(): Promise<void> {
		await telegramSource.logout();
		this.files.set([]);
		this.availableGroups.set(null);
		await this.refreshStatus();
	}

	/// Create a Telegram group on the signed-in account and switch to it.
	async createGroup(title: string): Promise<void> {
		const group = await telegramSource.createGroup(title);
		await this.showGroup(group);
	}

	/// Switch to a group: one already in use, or one from `availableGroups`.
	async selectGroup(id: string): Promise<void> {
		const group = await telegramSource.selectGroup(id);
		await this.showGroup(group);
	}

	async loadAvailableGroups(): Promise<void> {
		this.loadingGroups.set(true);
		try {
			this.availableGroups.set(await telegramSource.listAvailableGroups());
		} catch (err) {
			this.handleError(err);
		} finally {
			this.loadingGroups.set(false);
		}
	}

	async refreshGroupInfo(): Promise<void> {
		const groupId = this.activeGroupId();
		if (!groupId) return;
		try {
			const info = await telegramSource.getGroupInfo(groupId);
			if (this.activeGroupId() === groupId) this.groupInfo.set(info);
		} catch (err) {
			if (this.activeGroupId() === groupId) this.handleError(err);
		}
	}

	async refreshFiles(): Promise<void> {
		await this.loadFiles((groupId) => telegramSource.listFiles(groupId));
	}

	/// Catalog fast path: lists only the pipeline metadata sidecar rows
	/// (`metadata.role === "metadata"`). Triggers a metadata-only chat
	/// reconcile on the backend so the initial scan doesn't walk every
	/// media chunk — pair with `loadMediaForPipeline` to mint media rows
	/// on demand when the user hits play.
	async scanMetadata(): Promise<void> {
		await this.loadFiles((groupId) => telegramSource.scanMetadata(groupId));
	}

	/// Mint (if needed) and return the media row paired with this
	/// pipeline id. The source first looks in the local index, then —
	/// only when missing — runs a targeted chat walk that buffers just
	/// this pipeline's chunks. Backs the catalog's "fetch chunks on
	/// play" path so we don't pay the per-chunk cost until the user
	/// actually wants to watch something.
	///
	/// When the media upload is still in flight (catalog scan picked up
	/// the metadata sidecar from step 7 before step 8 has landed even
	/// chunk 0), the source returns 404. The streaming-while-uploading
	/// flow expects exactly that — chunk 0 lands within a few seconds
	/// of step 7 finishing, after which the row appears. Retry on the
	/// 404 with a short backoff so the user click that races chunk 0
	/// resolves cleanly instead of surfacing a transient "not found".
	async loadMediaForPipeline(pipelineId: string): Promise<TelegramFile> {
		const RETRIES = 12; // ~30 s total at 2.5 s per try
		const DELAY_MS = 2_500;
		const groupId = this.requireGroupId();
		for (let attempt = 0; attempt < RETRIES; attempt += 1) {
			try {
				return await telegramSource.loadMediaForPipeline(pipelineId, groupId);
			} catch (err) {
				const isLastAttempt = attempt === RETRIES - 1;
				if (err instanceof TelegramApiError && err.status === 404 && !isLastAttempt) {
					await new Promise((r) => setTimeout(r, DELAY_MS));
					continue;
				}
				throw err;
			}
		}
		// Unreachable — the loop either returns or throws.
		throw new TelegramApiError(404, {
			error: 'media upload not found after retries',
			code: 'not_found'
		});
	}

	async uploadFile(file: File): Promise<void> {
		await telegramSource.uploadFile(file, this.requireGroupId());
		await this.refreshFiles();
	}

	async deleteFile(id: string): Promise<void> {
		try {
			await telegramSource.deleteFile(id, this.requireGroupId());
		} finally {
			// Also when refused: part of it may have gone.
			await this.refreshFiles();
		}
	}

	async deleteAllFiles(): Promise<void> {
		try {
			await telegramSource.deleteAllFiles(this.requireGroupId());
		} finally {
			await this.refreshFiles();
		}
	}

	downloadUrl(id: string, groupId: string): string {
		return telegramSource.downloadUrl(id, groupId);
	}

	async startUpload(input: {
		path: string;
		name?: string;
		mimeType?: string;
		metadata?: unknown;
		refId?: string;
	}): Promise<TelegramUploadSnapshot> {
		const snapshot = await telegramSource.startUpload(input, this.requireGroupId());
		await this.refreshUploads();
		return snapshot;
	}

	async refreshUploads(): Promise<void> {
		try {
			this.uploads.set(await telegramSource.listUploads());
		} catch (err) {
			this.handleError(err);
		}
	}

	async pauseUpload(uploadId: string): Promise<void> {
		await telegramSource.pauseUpload(uploadId);
		await this.refreshUploads();
	}

	async resumeUpload(uploadId: string): Promise<void> {
		await telegramSource.resumeUpload(uploadId);
		await this.refreshUploads();
	}

	async cancelUpload(uploadId: string): Promise<void> {
		await telegramSource.cancelUpload(uploadId);
		await this.refreshUploads();
	}

	/// Start a 1 Hz background poll of the uploads list. Reference-counted
	/// so multiple components on different routes share a single timer.
	/// Returns a stop function the caller must invoke on teardown to
	/// release its reservation.
	watchUploads(): () => void {
		if (!browser) return () => {};
		this.uploadsWatchers += 1;
		if (this.uploadsWatchers === 1) {
			void this.refreshUploads();
			this.uploadsPollTimer = setInterval(() => {
				void this.refreshUploads();
			}, UPLOADS_POLL_MS);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.uploadsWatchers = Math.max(0, this.uploadsWatchers - 1);
			if (this.uploadsWatchers === 0 && this.uploadsPollTimer) {
				clearInterval(this.uploadsPollTimer);
				this.uploadsPollTimer = null;
			}
		};
	}

	private activeGroupId(): string | null {
		return get(this.status)?.activeGroupId ?? null;
	}

	private requireGroupId(): string {
		const groupId = this.activeGroupId();
		if (!groupId) throw new Error('Create or choose a backup group first.');
		return groupId;
	}

	private async loadFiles(load: (groupId: string) => Promise<TelegramFile[]>): Promise<void> {
		const groupId = this.activeGroupId();
		if (!groupId) return;
		const seq = ++this.filesSeq;
		this.loadingFiles.set(true);
		try {
			const files = await load(groupId);
			if (seq === this.filesSeq && this.activeGroupId() === groupId) this.files.set(files);
		} catch (err) {
			if (seq === this.filesSeq) this.handleError(err);
		} finally {
			if (seq === this.filesSeq) this.loadingFiles.set(false);
		}
	}

	private clearGroupView(): void {
		this.filesSeq += 1;
		this.files.set([]);
		this.groupInfo.set(null);
		this.loadingFiles.set(false);
	}

	private async showGroup(group: TelegramGroup): Promise<void> {
		// Any status still in flight predates the switch.
		this.appliedStatusSeq = ++this.statusSeq;
		const status = get(this.status);
		if (status) {
			if (status.activeGroupId !== group.id) this.clearGroupView();
			const known = status.groups.some((existing) => existing.id === group.id);
			const groups = known
				? status.groups.map((existing) => (existing.id === group.id ? group : existing))
				: [...status.groups, group];
			this.status.set({ ...status, groups, activeGroupId: group.id });
		}
		await this.refreshStatus();
	}

	private handleError(err: unknown): void {
		const message =
			err instanceof TelegramApiError
				? err.message
				: err instanceof Error
					? err.message
					: String(err);
		this.lastError.set(message);
	}
}

export const telegramService = new TelegramService();

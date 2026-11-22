import { ApiTelegramSource } from './api-telegram-source';
import type { TelegramSource } from './telegram-source';

/** The single shared Telegram data source. */
export const telegramSource: TelegramSource = new ApiTelegramSource();

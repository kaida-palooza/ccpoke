import TelegramBot from "node-telegram-bot-api";

import { t } from "../../i18n/index.js";
import { logger } from "../../utils/log.js";

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const PAGINATION_FOOTER_RESERVE = 30;
const SPLIT_LOOKBACK_RANGE = 200;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

export async function sendTelegramMessage(
  bot: TelegramBot,
  chatId: number,
  text: string,
  responseUrl?: string,
  sessionId?: string
): Promise<void> {
  const pages = splitMessage(text, TELEGRAM_MAX_MESSAGE_LENGTH - PAGINATION_FOOTER_RESERVE);

  for (let i = 0; i < pages.length; i++) {
    let content = pages[i]!;
    if (pages.length > 1) {
      content = `${content}\n\n_\\[${i + 1}/${pages.length}\\]_`;
    }

    const isLastPage = i === pages.length - 1;
    const opts: TelegramBot.SendMessageOptions = { parse_mode: "MarkdownV2" };

    if (isLastPage && responseUrl) {
      opts.reply_markup = buildResponseReplyMarkup(responseUrl, sessionId);
    }

    await sendWithRetry(bot, chatId, content, pages[i]!, opts, isLastPage, responseUrl, sessionId);
  }
}

async function sendWithRetry(
  bot: TelegramBot,
  chatId: number,
  content: string,
  rawContent: string,
  opts: TelegramBot.SendMessageOptions,
  isLastPage: boolean,
  responseUrl?: string,
  sessionId?: string
): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // First attempt: MarkdownV2 with full formatting
      // Subsequent attempts: plain text fallbacks
      if (attempt === 0) {
        await bot.sendMessage(chatId, content, opts);
      } else if (attempt === 1) {
        const fallbackOpts: TelegramBot.SendMessageOptions = {};
        if (isLastPage && responseUrl) {
          fallbackOpts.reply_markup = buildResponseReplyMarkup(responseUrl, sessionId);
        }
        await bot.sendMessage(chatId, rawContent, fallbackOpts);
      } else {
        await bot.sendMessage(chatId, rawContent);
      }
      return;
    } catch (error: any) {
      const isLastAttempt = attempt === MAX_RETRIES - 1;

      if (error?.response?.statusCode === 429) {
        const retryAfter =
          error?.response?.parameters?.retry_after ?? RETRY_DELAYS_MS[attempt]! / 1000;
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
      } else if (!isLastAttempt) {
        logger.error(
          { err: error },
          attempt === 0 ? t("bot.sendFailed") : t("bot.sendFallbackFailed")
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]!));
      } else {
        logger.error({ err: error }, t("bot.sendFallbackFailed"));
      }
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const pages: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      pages.push(remaining);
      break;
    }

    const splitAt = findSplitPoint(remaining, maxLen);
    pages.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return pages;
}

function findSplitPoint(text: string, maxLen: number): number {
  const searchStart = Math.max(0, maxLen - SPLIT_LOOKBACK_RANGE);

  for (let i = maxLen; i > searchStart; i--) {
    if (text[i] === "\n" && text[i - 1] === "\n") return i + 1;
  }

  for (let i = maxLen; i > searchStart; i--) {
    if (text[i] === "\n" && text[i - 1] !== "\\") return i + 1;
  }

  for (let i = maxLen; i > searchStart; i--) {
    if (text[i] === " " && text[i - 1] !== "\\") return i + 1;
  }

  return maxLen;
}

function buildResponseReplyMarkup(
  responseUrl: string,
  sessionId?: string
): TelegramBot.InlineKeyboardMarkup {
  const viewText = `📖 ${t("bot.viewDetails")}`;
  const viewButton = responseUrl.startsWith("https://")
    ? { text: viewText, web_app: { url: responseUrl } }
    : { text: viewText, url: responseUrl };

  const buttons: TelegramBot.InlineKeyboardButton[] = [viewButton];

  if (sessionId) {
    buttons.push({ text: "💬 Chat", callback_data: `chat:${sessionId}` });
  }

  return { inline_keyboard: [buttons] };
}

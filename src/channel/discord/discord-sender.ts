import type { DMChannel, EmbedBuilder, TextChannel } from "discord.js";

import { logger } from "../../utils/log.js";

const DISCORD_MAX_CONTENT_LENGTH = 2000;

export async function sendDiscordDM(
  channel: DMChannel | TextChannel,
  content: string,
  embeds?: EmbedBuilder[]
): Promise<void> {
  const pages = splitContent(content);

  for (let i = 0; i < pages.length; i++) {
    const isLast = i === pages.length - 1;
    try {
      await channel.send({
        content: pages[i] || undefined,
        embeds: isLast && embeds ? embeds : undefined,
      });
    } catch (err) {
      logger.error({ err }, "[Discord] send failed");
      throw err;
    }
  }
}

function splitContent(text: string): string[] {
  if (text.length <= DISCORD_MAX_CONTENT_LENGTH) return [text];

  const pages: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_CONTENT_LENGTH) {
      pages.push(remaining);
      break;
    }

    let splitAt = DISCORD_MAX_CONTENT_LENGTH;
    const newline = remaining.lastIndexOf("\n", DISCORD_MAX_CONTENT_LENGTH);
    if (newline > DISCORD_MAX_CONTENT_LENGTH - 200) splitAt = newline + 1;

    pages.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return pages;
}

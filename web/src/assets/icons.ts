import chevronDown from "./icons/chevron-down.svg?raw";
import github from "./icons/github.svg?raw";
import github16 from "./icons/github-16.svg?raw";
import menu from "./icons/menu.svg?raw";
import close from "./icons/close.svg?raw";
import bot from "./icons/bot.svg?raw";
import smartphone from "./icons/smartphone.svg?raw";
import copy from "./icons/copy.svg?raw";
import zap from "./icons/zap.svg?raw";
import repeat from "./icons/repeat.svg?raw";
import fileText from "./icons/file-text.svg?raw";
import filePlus from "./icons/file-plus.svg?raw";
import lock from "./icons/lock.svg?raw";
import chevronDown16 from "./icons/chevron-down-16.svg?raw";
import alertCircle from "./icons/alert-circle.svg?raw";
import sun from "./icons/sun.svg?raw";
import moon from "./icons/moon.svg?raw";
import logoFilled from "./icons/logo/filled.svg?raw";
import logoFilledRocket from "./icons/logo/filled-rocket.svg?raw";
import logoOutline from "./icons/logo/outline.svg?raw";
import logoOutlineRocket from "./icons/logo/outline-rocket.svg?raw";
import brandClaude from "./icons/brands/claude.svg?raw";
import brandCopilot from "./icons/brands/copilot.svg?raw";
import brandCursor from "./icons/brands/cursor.svg?raw";
import brandDiscord from "./icons/brands/discord.svg?raw";
import brandGemini from "./icons/brands/gemini.svg?raw";
import brandGoogle from "./icons/brands/google.svg?raw";
import brandOpenai from "./icons/brands/openai.svg?raw";
import brandOpencode from "./icons/brands/opencode.svg?raw";
import brandSlack from "./icons/brands/slack.svg?raw";
import brandTelegram from "./icons/brands/telegram.svg?raw";
import brandZalo from "./icons/brands/zalo.svg?raw";

export const icons = {
  chevronDown,
  github,
  github16,
  menu,
  close,
  bot,
  smartphone,
  copy,
  zap,
  repeat,
  fileText,
  filePlus,
  lock,
  chevronDown16,
  alertCircle,
  sun,
  moon,
  logoFilled,
  logoFilledRocket,
  logoOutline,
  logoOutlineRocket,
  brandClaude,
  brandCopilot,
  brandCursor,
  brandDiscord,
  brandGemini,
  brandGoogle,
  brandOpenai,
  brandOpencode,
  brandSlack,
  brandTelegram,
  brandZalo,
} as const;

export type IconName = keyof typeof icons;


import { DEFAULTS, type ThemeConfig } from "../shared/theme";

export type MessageFilterRules = Pick<
  ThemeConfig,
  "hideNumbers" | "filterWords" | "filterPrefixes" | "hideBots" | "showSharedChat" | "botNames"
>;

export const DEFAULT_FILTER_RULES: MessageFilterRules = {
  hideNumbers: DEFAULTS.hideNumbers,
  filterWords: DEFAULTS.filterWords,
  filterPrefixes: DEFAULTS.filterPrefixes,
  hideBots: DEFAULTS.hideBots,
  showSharedChat: DEFAULTS.showSharedChat,
  botNames: DEFAULTS.botNames,
};

export function shouldFilterMessage(
  message: { text: string; userLogin: string | null; roomId?: string | null; sourceRoomId?: string | null },
  rules: MessageFilterRules,
): boolean {
  if (!rules.showSharedChat && message.sourceRoomId && message.sourceRoomId !== message.roomId) return true;
  if (rules.hideNumbers && containsOnlyNumbers(message.text)) return true;
  const normalized = message.text.trim().toLocaleLowerCase("en-US");
  for (const word of rules.filterWords) {
    if (normalized === word.toLocaleLowerCase("en-US")) return true;
  }
  for (const prefix of rules.filterPrefixes) {
    if (startsWithIgnoringCase(message.text, prefix)) return true;
  }
  if (rules.hideBots && message.userLogin) {
    const login = message.userLogin.toLocaleLowerCase("en-US");
    for (const bot of rules.botNames) {
      if (login === bot.toLocaleLowerCase("en-US")) return true;
    }
  }
  return false;
}

function containsOnlyNumbers(value: string): boolean {
  let hasDigit = false;
  for (const character of value) {
    if (character >= "0" && character <= "9") {
      hasDigit = true;
      continue;
    }
    if (character === " " || character === "\t" || character === "\n" || character === "\r") continue;
    return false;
  }
  return hasDigit;
}

function startsWithIgnoringCase(value: string, prefix: string): boolean {
  if (prefix.length > value.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    const valueCode = value.charCodeAt(index);
    const prefixCode = prefix.charCodeAt(index);
    if (lowerAscii(valueCode) !== lowerAscii(prefixCode)) return false;
  }
  return true;
}

function lowerAscii(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

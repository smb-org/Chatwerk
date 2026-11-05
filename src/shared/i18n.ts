import english from "./i18n/en.json";
import german from "./i18n/de.json";

export type Language = "en" | "de";
export type TranslationKey = keyof typeof english;
export type TranslationValues = Record<string, string | number>;

const translations: Record<Language, Record<TranslationKey, string>> = { en: english, de: german };
const LANGUAGE_KEY = "chatwerk-language";

export function browserLanguage(language = typeof navigator === "undefined" ? "en" : navigator.language): Language {
  return language.toLowerCase().startsWith("de") ? "de" : "en";
}

export function currentLanguage(storage: Pick<Storage, "getItem"> | undefined = getStorage()): Language {
  try {
    const saved = storage?.getItem(LANGUAGE_KEY);
    if (saved === "en" || saved === "de") return saved;
  } catch {
    // Browser storage is optional, including in sandboxed embeds.
  }
  return browserLanguage();
}

export function saveLanguage(language: Language, storage: Pick<Storage, "setItem"> | undefined = getStorage()): void {
  try { storage?.setItem(LANGUAGE_KEY, language); } catch { /* The current page still uses the selected language. */ }
}

export function translate(language: Language, key: TranslationKey, values: TranslationValues = {}): string {
  return translations[language][key].replace(/\{([\w]+)\}/gu, (_match, name: string) => String(values[name] ?? ""));
}

function getStorage(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

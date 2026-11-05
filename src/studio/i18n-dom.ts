import { translate, type Language, type TranslationKey } from "../shared/i18n";

export function applyTranslations(root: ParentNode, language: Language): void {
  const doc = root instanceof Document ? root : root.ownerDocument;
  if (doc) doc.documentElement.lang = language;
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key) element.textContent = translate(language, key as TranslationKey);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    const key = element.dataset.i18nAriaLabel;
    if (key) element.setAttribute("aria-label", translate(language, key as TranslationKey));
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    const key = element.dataset.i18nTitle;
    if (key) element.title = translate(language, key as TranslationKey);
  }
}

import "./studio.css";
import { currentLanguage, translate } from "../shared/i18n";
import { applyTranslations } from "./i18n-dom";

const language = currentLanguage();
applyTranslations(document, language);
document.title = translate(language, "brand");

const errorLine = document.querySelector<HTMLElement>("#login-error");
const params = new URLSearchParams(window.location.search);
if (params.has("error") && errorLine) errorLine.textContent = translate(language, "loginError");

const loginButton = document.querySelector<HTMLAnchorElement>("#login-button");
if (loginButton) {
  const next = params.get("next");
  if (next !== null) loginButton.setAttribute("href", `/auth/login?next=${encodeURIComponent(next)}`);
  loginButton.addEventListener("click", () => {
    loginButton.setAttribute("aria-disabled", "true");
    loginButton.textContent = translate(language, "loginOpening");
  });
}

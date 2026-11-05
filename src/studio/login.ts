import "./studio.css";
import { currentLanguage, translate } from "../shared/i18n";
import { applyTranslations } from "./i18n-dom";

const language = currentLanguage();
applyTranslations(document, language);
document.title = translate(language, "brand");

const errorLine = document.querySelector<HTMLElement>("#login-error");
const params = new URLSearchParams(window.location.search);
if (params.has("error") && errorLine) errorLine.textContent = translate(language, "loginError");

const form = document.querySelector<HTMLFormElement>("#login-form");
const loginButton = document.querySelector<HTMLButtonElement>("#login-button");
if (form && loginButton) {
  const next = document.querySelector<HTMLInputElement>("#login-next");
  if (next) next.value = params.get("next") ?? "";
  form.addEventListener("submit", () => {
    loginButton.disabled = true;
    loginButton.textContent = translate(language, "loginOpening");
  });
}

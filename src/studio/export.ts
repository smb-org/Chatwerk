import "./studio.css";
import { currentLanguage, translate } from "../shared/i18n";
import { applyTranslations } from "./i18n-dom";

const language = currentLanguage();
applyTranslations(document, language);
document.title = `${translate(language, "brand")} · ${translate(language, "widgetExport")}`;

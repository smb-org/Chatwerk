import { translate, type Language } from "../shared/i18n";

export interface WidgetExportBlocks {
  html: string;
  js: string;
  fields: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function buildWidgetExport(origin: string, token: string, language: Language): WidgetExportBlocks {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.origin !== origin || !["http:", "https:"].includes(parsedOrigin.protocol)) {
    throw new TypeError("Expected an HTTP origin");
  }
  if (!TOKEN_PATTERN.test(token)) throw new TypeError("Invalid overlay token");

  const overlayUrl = `${parsedOrigin.origin}/overlay#token=${token}&client=widget&placement=origin`;
  const html = [
    "<!-- Chatwerk widget · HTML tab -->",
    "<style>",
    "  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }",
    "  #chatwerkFrame { display: block; width: 100%; height: 100%; border: 0; background: transparent; }",
    "  #chatwerkError { display: none; font: 14px system-ui, sans-serif; color: #fff; padding: 8px; }",
    "</style>",
    '<iframe id="chatwerkFrame" allowtransparency="true" scrolling="no" sandbox="allow-scripts"></iframe>',
    `<div id="chatwerkError">${translate(language, "widgetUrlMissing")}</div>`,
  ].join("\n");
  const js = [
    "// Chatwerk widget · JS tab · ES2018",
    "window.addEventListener('onWidgetLoad', function (event) {",
    "  var frame = document.getElementById('chatwerkFrame');",
    "  var error = document.getElementById('chatwerkError');",
    "  var data = event.detail.fieldData;",
    "  var url = String(data.overlayUrl || '').trim();",
    "  if (url.indexOf('https://') !== 0) {",
    "    frame.style.display = 'none';",
    "    error.style.display = 'block';",
    "    return;",
    "  }",
    "  frame.src = url;",
    "});",
  ].join("\n");
  const fields = JSON.stringify({
    overlayUrl: {
      type: "text",
      label: translate(language, "exportFieldLabel"),
      value: overlayUrl,
      group: "Chatwerk",
    },
  }, null, 2);
  return { html, js, fields };
}

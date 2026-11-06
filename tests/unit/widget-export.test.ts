import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildWidgetExport, buildWidgetOverlayUrl } from "../../src/studio/widget-export";

describe("StreamElements and SoundAlerts widget output", () => {
  it("builds the widget overlay link with the existing client and placement parameters", () => {
    expect(buildWidgetOverlayUrl("https://chatwerk.test", "a".repeat(43)))
      .toBe("https://chatwerk.test/overlay#token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&client=widget&placement=origin");
  });

  it("keeps the three exported blocks stable and points the widget at the full token URL", () => {
    const blocks = buildWidgetExport("https://chatwerk.test", "a".repeat(43), "en");
    expect(blocks).toMatchInlineSnapshot(`
      {
        "fields": "{
        "overlayUrl": {
          "type": "text",
          "label": "Overlay URL (full URL incl. #token=...)",
          "value": "https://chatwerk.test/overlay#token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&client=widget&placement=origin",
          "group": "Chatwerk"
        }
      }",
        "html": "<!-- Chatwerk widget · HTML tab -->
      <style>
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
        #chatwerkFrame { display: block; width: 100%; height: 100%; border: 0; background: transparent; }
        #chatwerkError { display: none; font: 14px system-ui, sans-serif; color: #fff; padding: 8px; }
      </style>
      <iframe id="chatwerkFrame" allowtransparency="true" scrolling="no" sandbox="allow-scripts"></iframe>
      <div id="chatwerkError">Chatwerk: Overlay URL is missing or invalid.</div>",
        "js": "// Chatwerk widget · JS tab · ES2018
      window.addEventListener('onWidgetLoad', function (event) {
        var frame = document.getElementById('chatwerkFrame');
        var error = document.getElementById('chatwerkError');
        var data = event.detail.fieldData;
        var url = String(data.overlayUrl || '').trim();
        if (url.indexOf('https://') !== 0) {
          frame.style.display = 'none';
          error.style.display = 'block';
          return;
        }
        frame.src = url;
      });",
      }
    `);
  });

  it("parses as ES2018 and rejects non-https overlay URLs", () => {
    const { js } = buildWidgetExport("https://chatwerk.test", "b".repeat(43), "en");
    const parsed = ts.transpileModule(js, {
      compilerOptions: { allowJs: true, target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.ES2015 },
      reportDiagnostics: true,
    });

    expect(parsed.diagnostics ?? []).toHaveLength(0);
    expect(js).toContain("url.indexOf('https://') !== 0");
  });
});

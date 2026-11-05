import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const load = (language: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(process.cwd(), `src/shared/i18n/${language}.json`), "utf8")) as Record<string, string>;

describe("Studio translations", () => {
  it("uses identical keys for English and German", () => {
    expect(Object.keys(load("de")).sort()).toEqual(Object.keys(load("en")).sort());
  });

  it("keeps product copy and fixed login error text in both languages", () => {
    const english = load("en");
    const german = load("de");
    expect(english.loginProduct).toBe("Design your Twitch chat for OBS and share the look.");
    expect(english.loginStorage).toBe("We store your Twitch name and id. Chat is never stored.");
    expect(english.loginError).toBe("Twitch login did not complete. Try again.");
    expect(german.loginProduct).toContain("Twitch-Chat");
    expect(german.loginStorage).toContain("Chat wird nie gespeichert");
    expect(german.loginError).toContain("Twitch-Anmeldung");
    expect(german.loginProduct + german.loginStorage + german.loginError).toMatch(/[äöüÄÖÜß]/u);
  });

  it("translates the new message controls and disabled Themes hint in both languages", () => {
    for (const key of ["fieldEmoteScale", "fieldShowBadges", "fieldShowPronouns", "comingSoon", "channelValue"]) {
      expect(load("en")[key]).toBeTruthy();
      expect(load("de")[key]).toBeTruthy();
    }
    expect(load("en").comingSoon).toBe("Coming soon");
    expect(load("de").comingSoon).toBe("Demnächst verfügbar");
  });

  it("translates all display switch labels and limit states in both languages", () => {
    for (const key of [
      "groupEmotesEffects", "fieldEmotes7tv", "fieldEmotesBttv", "fieldEmotesFfz", "fieldShowPaints",
      "fieldNeverFade", "fieldMaxLines", "fieldMaxChatHeight", "fullHeight", "linesUnit",
      "groupPanel", "fieldPanelEnabled", "fieldPanelBackgroundColor", "fieldPanelBackgroundOpacity",
      "fieldPanelBorderWidth", "fieldPanelBorderColor", "fieldPanelRadius", "fieldPanelPadding",
      "fieldLinePadding", "fieldBacklog", "backlogStackOnlyHint", "fieldBadges7tv", "fieldBadgesBttv",
      "fieldBadgesFfz", "fieldBadgesChatterino",
    ]) {
      expect(load("en")[key], `English translation missing ${key}`).toBeTruthy();
      expect(load("de")[key], `German translation missing ${key}`).toBeTruthy();
    }
    expect(load("en").fullHeight).toBe("Full height");
    expect(load("de").fullHeight).toBe("Volle Höhe");
  });

  it("translates every new ChatIS display option in both languages", () => {
    for (const key of [
      "fieldTextShadow", "fieldSmallCaps", "fieldNameOnOwnLine", "fieldHideNames", "fieldBadgesHomies", "fieldReadableNames",
    ]) {
      expect(load("en")[key], `English translation missing ${key}`).toBeTruthy();
      expect(load("de")[key], `German translation missing ${key}`).toBeTruthy();
    }
  });

  it("provides truthful initial-load retry status in both languages", () => {
    expect(load("en").couldNotLoadRetrying).toBe("Could not load. Retrying...");
    expect(load("de").couldNotLoadRetrying).toBe("Laden fehlgeschlagen. Neuer Versuch …");
  });

  it("translates each Hype Train control, permission state, action, and rehearsal label", () => {
    for (const key of [
      "hypeTrain", "fieldReactionHypeTrain", "hypeTrainLoading", "hypeTrainStatusUnavailable",
      "hypeTrainNotConnected", "hypeTrainConnected", "hypeTrainConnect", "hypeTrainDisconnect",
      "hypeTrainPermissionExplanation", "hypeTrainHelper", "hypeTrainConnectSuccess", "hypeTrainDenied",
      "hypeTrainScopeMissing", "hypeTrainUserMismatch", "hypeTrainConnectFailed", "hypeTrainSessionExpired",
      "hypeTrainDisconnected", "hypeTrainDisconnectFailed",
    ]) {
      expect(load("en")[key], `English translation missing ${key}`).toBeTruthy();
      expect(load("de")[key], `German translation missing ${key}`).toBeTruthy();
    }
  });
});

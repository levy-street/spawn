import {
  attachmentPasteSequence,
  bracketedPaste,
  shellQuotePath,
} from "@/components/terminal-ui/attachment-paste";

const ESC = "";

describe("attachment paste", () => {
  test("quotes only what a shell would misread", () => {
    expect(shellQuotePath("/Users/x/.spawn/attachments/photo.jpg")).toBe(
      "/Users/x/.spawn/attachments/photo.jpg",
    );
    expect(shellQuotePath("/Users/x/my photo.jpg")).toBe("'/Users/x/my photo.jpg'");
    // A quote in the name has to close, escape and reopen, or it ends the path.
    expect(shellQuotePath("/Users/x/it's.jpg")).toBe("'/Users/x/it'\\''s.jpg'");
  });

  test("wraps the path as a paste, which is how a drag arrives on a desk", () => {
    expect(bracketedPaste("x")).toBe(`${ESC}[200~x${ESC}[201~`);
  });

  test("keeps the path absolute so the agent can resolve it to a file", () => {
    const path = "/Users/x/dev/spawn/.spawn/attachments/1787454986-IMG_2862.png";

    // Shortening this to `.spawn/attachments/…` is what left it sitting at the
    // prompt as literal text instead of becoming an image.
    expect(attachmentPasteSequence(path)).toBe(`${ESC}[200~${path}${ESC}[201~`);
    expect(attachmentPasteSequence(path)).toContain("/Users/x/dev/spawn/");
  });

  test("still quotes an absolute path that needs it", () => {
    expect(attachmentPasteSequence("/Users/x/.spawn/attachments/a b.png")).toBe(
      `${ESC}[200~'/Users/x/.spawn/attachments/a b.png'${ESC}[201~`,
    );
  });
});

import { describe, expect, test } from "bun:test";

import {
  announceModalOpen,
  type LayerElement,
  menuOrDialogOpen,
  subscribeToModalOpen,
} from "./modal-layer";

describe("modal layer", () => {
  test("a popup already up when a modal opens is dismissed", () => {
    let dismissed = 0;
    const stop = subscribeToModalOpen(() => {
      dismissed += 1;
    });
    announceModalOpen();
    expect(dismissed).toBe(1);
    stop();
  });

  test("a popup opened from inside a modal is not dismissed by it", () => {
    // The order is the whole rule: the dialog announced itself before this
    // menu existed, so the menu — its own child — never hears about it.
    announceModalOpen();
    let dismissed = 0;
    const stop = subscribeToModalOpen(() => {
      dismissed += 1;
    });
    expect(dismissed).toBe(0);
    stop();
  });

  test("a dismissed popup unsubscribing mid-announcement still lets its peers hear it", () => {
    // What actually happens on dismissal: closing unmounts the effect, which
    // unsubscribes while the announcement is still being delivered.
    const heard: string[] = [];
    const stopFirst = subscribeToModalOpen(() => {
      heard.push("first");
      stopFirst();
    });
    const stopSecond = subscribeToModalOpen(() => {
      heard.push("second");
      stopSecond();
    });

    announceModalOpen();
    expect(heard).toEqual(["first", "second"]);

    // Both are gone: a second modal reaches neither.
    announceModalOpen();
    expect(heard).toEqual(["first", "second"]);
  });

  test("an unsubscribed popup hears nothing", () => {
    let dismissed = 0;
    subscribeToModalOpen(() => {
      dismissed += 1;
    })();
    announceModalOpen();
    expect(dismissed).toBe(0);
  });
});

/** A stand-in element: its attributes, and what it contains. */
interface FakeElement extends LayerElement<FakeElement> {
  children: FakeElement[];
}

function element(attributes: Record<string, string>, children: FakeElement[] = []): FakeElement {
  const self: FakeElement = {
    children,
    getAttribute: (name) => attributes[name] ?? null,
    contains: (other) =>
      other !== null && (other === self || self.children.some((child) => child.contains(other))),
  };
  return self;
}

/** A document whose only open layers are `layers`, matched the way the selector would. */
function documentWith(...layers: FakeElement[]) {
  const selectors: string[] = [];
  return {
    selectors,
    querySelectorAll(selector: string) {
      selectors.push(selector);
      return layers;
    },
  };
}

describe("menuOrDialogOpen", () => {
  const list = element({ role: "tree" });

  test("nothing open: a card may show", () => {
    expect(menuOrDialogOpen(documentWith(), list)).toBe(false);
  });

  test("asks for menus, dialogs, alert dialogs and anything aria-modal", () => {
    const doc = documentWith();
    menuOrDialogOpen(doc, list);
    const selector = doc.selectors[0] ?? "";
    for (const part of [
      '[role="menu"]',
      '[role="dialog"]',
      '[role="alertdialog"]',
      '[aria-modal="true"]',
    ]) {
      expect(selector).toContain(part);
    }
    // The hover card itself is a labelled group, never one of these.
    expect(selector).not.toContain("group");
  });

  test("a menu open anywhere blocks the card", () => {
    expect(menuOrDialogOpen(documentWith(element({ role: "menu" })), list)).toBe(true);
  });

  test("a dialog that has taken the window blocks the card", () => {
    expect(
      menuOrDialogOpen(documentWith(element({ role: "dialog", "data-state": "open" })), list),
    ).toBe(true);
  });

  test("the drawer the list itself lives in is ground, not a layer over it", () => {
    const drawer = element({ role: "dialog", "aria-modal": "true" }, [list]);
    expect(menuOrDialogOpen(documentWith(drawer), list)).toBe(false);
    // A menu opened from inside that drawer still blocks.
    expect(menuOrDialogOpen(documentWith(drawer, element({ role: "menu" })), list)).toBe(true);
  });

  test("a dialog playing its closing animation is already gone", () => {
    expect(
      menuOrDialogOpen(documentWith(element({ role: "dialog", "data-state": "closed" })), list),
    ).toBe(false);
  });

  test("with no list to stand in, every layer counts", () => {
    const drawer = element({ role: "dialog" }, [list]);
    expect(menuOrDialogOpen(documentWith(drawer), null)).toBe(true);
  });
});

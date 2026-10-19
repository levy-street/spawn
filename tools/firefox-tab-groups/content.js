/*
 * SPAWN D Tab Groups — Firefox-style tab groups for SPAWN D's workspace tab strip.
 *
 * SPAWN D has no plugin API, so this script works on the page as rendered:
 *
 *  - Tabs are found by the attributes SPAWN D stamps for its own pane drag:
 *    `[data-workspace-tab-strip]` (owner = workspace id) and, inside it, one
 *    `button[data-workspace-tab=<tab id>]` per tab, wrapped in a div.
 *  - Groups live in extension storage, keyed by workspace id: each group's
 *    name, colour and collapsed state, plus which tab ids belong to it. SPAWN D
 *    itself never hears about groups, so other devices see plain tabs.
 *  - Like Firefox, a group's tabs are always next to each other. When a tab
 *    joins a group the script moves it there through SPAWN D's own keyboard
 *    reorder (Alt+Shift+Arrow on the tab), so the order is saved to the
 *    workspace the normal way. When you reorder tabs yourself, a tab dropped
 *    inside a group joins it and a tab dragged out of its group leaves it.
 *
 * Everything this script adds carries a `stg` class or data attribute.
 */
(() => {
  "use strict";
  if (window.__spawnTabGroups) return;
  window.__spawnTabGroups = true;

  // Firefox's nine tab group colours, tuned to read on SPAWN D's dark shell.
  const COLORS = [
    { id: "blue", label: "Blue", hex: "#4a9df8" },
    { id: "purple", label: "Purple", hex: "#b17bf5" },
    { id: "cyan", label: "Cyan", hex: "#3fc8d8" },
    { id: "orange", label: "Orange", hex: "#f5913e" },
    { id: "yellow", label: "Yellow", hex: "#f2c94c" },
    { id: "pink", label: "Pink", hex: "#f472b6" },
    { id: "green", label: "Green", hex: "#5cc77a" },
    { id: "gray", label: "Gray", hex: "#9aa0a6" },
    { id: "red", label: "Red", hex: "#f2545b" },
  ];
  const colorHex = (id) => (COLORS.find((c) => c.id === id) ?? COLORS[0]).hex;
  const groupName = (group) => group.name.trim() || "Unnamed group";

  /** How long a "New tab in group" waits for the tab to be made. */
  const PENDING_NEW_TAB_MS = 120_000;

  // ---------------------------------------------------------------- storage

  const PREFIX = "spawn-tab-groups:";
  const ext = globalThis.browser?.storage?.local ? globalThis.browser : null;
  const storage = ext
    ? {
        async get(owner) {
          const result = await ext.storage.local.get(PREFIX + owner);
          return result[PREFIX + owner] ?? null;
        },
        set: (owner, value) => ext.storage.local.set({ [PREFIX + owner]: value }),
        onChange(callback) {
          ext.storage.onChanged.addListener((changes, area) => {
            if (area !== "local") return;
            for (const key of Object.keys(changes)) {
              if (key.startsWith(PREFIX)) callback(key.slice(PREFIX.length), changes[key].newValue);
            }
          });
        },
      }
    : {
        // The userscript build (and the dev mock) keep groups in the page's
        // own localStorage instead.
        async get(owner) {
          try {
            return JSON.parse(localStorage.getItem(PREFIX + owner) ?? "null");
          } catch {
            return null;
          }
        },
        async set(owner, value) {
          try {
            localStorage.setItem(PREFIX + owner, JSON.stringify(value));
          } catch {}
        },
        onChange(callback) {
          window.addEventListener("storage", (event) => {
            if (!event.key?.startsWith(PREFIX)) return;
            try {
              callback(event.key.slice(PREFIX.length), JSON.parse(event.newValue ?? "null"));
            } catch {}
          });
        },
      };

  /**
   * Per-workspace state:
   *   groups: { [groupId]: { name, color, collapsed } }
   *   member: { [tabId]: groupId }
   *   order:  tab ids as last seen, to tell which tab moved
   */
  const states = new Map();
  const loading = new Set();
  const lastSaved = new Map();
  const saveTimers = new Map();

  const normalise = (raw) => ({
    groups: raw && typeof raw.groups === "object" ? raw.groups : {},
    member: raw && typeof raw.member === "object" ? raw.member : {},
    order: Array.isArray(raw?.order) ? raw.order : [],
  });

  function stateFor(owner) {
    if (!owner) return null;
    const state = states.get(owner);
    if (state) return state;
    if (!loading.has(owner)) {
      loading.add(owner);
      storage
        .get(owner)
        .then((raw) => {
          states.set(owner, normalise(raw));
          lastSaved.set(owner, JSON.stringify(raw ?? null));
        })
        .catch(() => states.set(owner, normalise(null)))
        .finally(() => {
          loading.delete(owner);
          scheduleRender();
        });
    }
    return null;
  }

  function save(owner) {
    clearTimeout(saveTimers.get(owner));
    saveTimers.set(
      owner,
      setTimeout(() => {
        const state = states.get(owner);
        if (!state) return;
        lastSaved.set(owner, JSON.stringify(state));
        storage.set(owner, state);
      }, 120),
    );
  }

  // Another window (or the same workspace in another browser tab) changed it.
  storage.onChange((owner, value) => {
    const json = JSON.stringify(value ?? null);
    if (json === lastSaved.get(owner)) return;
    lastSaved.set(owner, json);
    states.set(owner, normalise(value));
    scheduleRender();
  });

  // ------------------------------------------------------------- DOM reading

  const strips = () => [...document.querySelectorAll("[data-workspace-tab-strip]")];
  const ownerOf = (strip) => strip.getAttribute("data-workspace-tab-strip-owner");
  const stripFor = (owner) => strips().find((strip) => ownerOf(strip) === owner) ?? null;
  const tabButtons = (strip) =>
    [...strip.querySelectorAll("[data-workspace-tab]")].filter(
      (button) =>
        button.closest("[data-workspace-tab-strip]") === strip && button.parentElement !== strip,
    );
  const tabIdOf = (button) => button.getAttribute("data-workspace-tab");
  const orderOf = (strip) => tabButtons(strip).map(tabIdOf);
  const isActive = (button) => button.getAttribute("aria-selected") === "true";
  /** Mid-rename (a tab is a form) or mid-drag, the strip is not to be trusted. */
  const settled = (strip) => !strip.querySelector("form, [data-dragging]");
  const tabButton = (owner, tabId) =>
    stripFor(owner)?.querySelector(`[data-workspace-tab="${CSS.escape(tabId)}"]`) ?? null;

  // ---------------------------------------------------------- group algebra

  const membersOf = (state, groupId) =>
    Object.keys(state.member).filter((tabId) => state.member[tabId] === groupId);

  function dropEmptyGroups(state) {
    const used = new Set(Object.values(state.member));
    for (const groupId of Object.keys(state.groups)) {
      if (!used.has(groupId)) delete state.groups[groupId];
    }
    for (const [tabId, groupId] of Object.entries(state.member)) {
      if (!state.groups[groupId]) delete state.member[tabId];
    }
  }

  /** The tab that moved between two orders of the same tabs, if one did. */
  function findMoved(before, after) {
    const candidates = after.filter((id) => {
      const a = before.filter((x) => x !== id);
      const b = after.filter((x) => x !== id);
      return a.every((x, i) => x === b[i]);
    });
    if (candidates.length <= 1) return candidates[0] ?? null;
    // Two neighbours swapped: either could be "the one that moved". Believe
    // the tab the user is holding — focused by the keyboard reorder, or the
    // last one pressed for a drag.
    const focused = document.activeElement?.closest?.("[data-workspace-tab]");
    if (focused && candidates.includes(tabIdOf(focused))) return tabIdOf(focused);
    if (lastPressed && performance.now() - lastPressed.at < 10_000) {
      if (candidates.includes(lastPressed.tabId)) return lastPressed.tabId;
    }
    return candidates[0];
  }

  /**
   * A tab arrived at a new slot (moved, opened or duplicated): it joins the
   * group it landed inside, stays in its own group while it still touches it,
   * and otherwise leaves its group — the way a dragged tab behaves in Firefox.
   */
  function placeByNeighbours(state, order, tabId) {
    const index = order.indexOf(tabId);
    const left = state.member[order[index - 1]];
    const right = state.member[order[index + 1]];
    const own = state.member[tabId];
    if (left && left === right) {
      state.member[tabId] = left;
      return;
    }
    if (!own || left === own || right === own) return;
    // A group's only tab carries the group with it.
    if (membersOf(state, own).length === 1) return;
    delete state.member[tabId];
  }

  /** Groups stay in one run; any stragglers outside the longest run leave. */
  function keepContiguous(state, order) {
    for (const groupId of Object.keys(state.groups)) {
      const runs = [];
      let run = null;
      for (const tabId of order) {
        if (state.member[tabId] === groupId) {
          if (!run) runs.push((run = []));
          run.push(tabId);
        } else {
          run = null;
        }
      }
      if (runs.length <= 1) continue;
      const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
      for (const r of runs) if (r !== longest) for (const tabId of r) delete state.member[tabId];
    }
  }

  /** Fold what changed in the strip since we last looked into the groups. */
  function learnOrder(owner, state, order) {
    const before = JSON.stringify(state);
    const present = new Set(order);
    for (const tabId of Object.keys(state.member)) {
      if (!present.has(tabId)) delete state.member[tabId];
    }
    const known = new Set(state.order);
    const previous = state.order.filter((id) => present.has(id));
    const kept = order.filter((id) => known.has(id));
    const opened = order.filter((id) => !known.has(id));
    const touched = [...opened];
    if (previous.some((id, i) => id !== kept[i])) {
      const moved = findMoved(previous, kept);
      if (moved) touched.push(moved);
    }
    // "New tab in group": the first tab to appear joins the group.
    const pending = pendingNewTab;
    if (
      pending &&
      pending.owner === owner &&
      performance.now() < pending.until &&
      state.groups[pending.groupId] &&
      opened.length > 0 &&
      state.order.length > 0
    ) {
      // Joined (and walked to the group's end) once this pass is done.
      const tabId = opened[opened.length - 1];
      touched.splice(touched.indexOf(tabId), 1);
      pendingNewTab = null;
      queueMicrotask(() => moveIntoGroup(owner, tabId, pending.groupId));
    }
    for (const tabId of touched) placeByNeighbours(state, order, tabId);
    keepContiguous(state, order);
    dropEmptyGroups(state);
    state.order = order;
    return JSON.stringify(state) !== before;
  }

  function nextColor(state) {
    const used = Object.values(state.groups).map((group) => group.color);
    return (
      COLORS.find((c) => !used.includes(c.id)) ?? COLORS[used.length % COLORS.length]
    ).id;
  }

  // ----------------------------------------------------------------- paint

  const setFlag = (el, name, on) => {
    if (on && !el.hasAttribute(name)) el.setAttribute(name, "");
    else if (!on && el.hasAttribute(name)) el.removeAttribute(name);
  };
  const setAttr = (el, name, value) => {
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };
  const setColor = (el, hex) => {
    if (el.style.getPropertyValue("--stg-color") !== hex) el.style.setProperty("--stg-color", hex);
  };
  const setText = (el, text) => {
    if (el.textContent !== text) el.textContent = text;
  };

  function clearTab(wrap) {
    if (!wrap.hasAttribute("data-stg")) return;
    wrap.removeAttribute("data-stg");
    wrap.removeAttribute("data-stg-hidden");
    wrap.removeAttribute("data-stg-last");
    wrap.style.removeProperty("--stg-color");
  }

  function reconcile(strip) {
    const owner = ownerOf(strip);
    if (!owner) return;
    const state = stateFor(owner);
    if (!state || busy.has(owner) || !settled(strip)) return;
    const buttons = tabButtons(strip);
    if (buttons.length === 0) return;
    if (learnOrder(owner, state, buttons.map(tabIdOf))) save(owner);
    paint(strip, state, buttons);
  }

  function paint(strip, state, buttons) {
    const layoutBefore = layoutKey(strip);
    const runs = new Map();
    for (const button of buttons) {
      const wrap = button.parentElement;
      const groupId = state.member[tabIdOf(button)];
      const group = groupId ? state.groups[groupId] : null;
      if (!group) {
        clearTab(wrap);
        continue;
      }
      const active = isActive(button);
      setAttr(wrap, "data-stg", groupId);
      setColor(wrap, colorHex(group.color));
      setFlag(wrap, "data-stg-hidden", group.collapsed && !active);
      if (!runs.has(groupId)) runs.set(groupId, []);
      runs.get(groupId).push({ wrap, button, active });
    }
    for (const chip of strip.querySelectorAll(":scope > [data-stg-label]")) {
      if (!runs.has(chip.getAttribute("data-stg-label"))) chip.remove();
    }
    for (const [groupId, run] of runs) {
      const group = state.groups[groupId];
      const shown = run.filter((tab) => !group.collapsed || tab.active);
      for (const tab of run) setFlag(tab.wrap, "data-stg-last", tab === shown[shown.length - 1]);
      const chip = chipFor(strip, groupId);
      paintChip(chip, group, run, shown);
      if (chip.nextElementSibling !== run[0].wrap) strip.insertBefore(chip, run[0].wrap);
    }
    // Labels and collapsed tabs shift the open tab sideways. SPAWN D measures
    // where the open tab sits (to join it to the pane under it) on resize, so
    // tell it to look again.
    if (layoutKey(strip) !== layoutBefore) {
      setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
    }
  }

  /** What decides where the strip's tabs sit: which tabs show, and the labels. */
  const layoutKey = (strip) =>
    [...strip.children]
      .filter((el) => !el.hasAttribute("data-stg-hidden"))
      .map((el) => el.getAttribute("data-stg-label") ?? el.firstElementChild?.getAttribute?.("data-workspace-tab") ?? "")
      .join() +
    [...strip.querySelectorAll(".stg-label-name, .stg-label-count")].map((el) => el.textContent).join();

  function chipFor(strip, groupId) {
    const existing = strip.querySelector(`:scope > [data-stg-label="${CSS.escape(groupId)}"]`);
    if (existing) return existing;
    const slot = document.createElement("div");
    slot.className = "stg-slot";
    slot.setAttribute("data-stg-label", groupId);
    const label = document.createElement("button");
    label.type = "button";
    label.className = "stg-label";
    for (const part of ["stg-label-name", "stg-label-count", "stg-label-alert"]) {
      const span = document.createElement("span");
      span.className = part;
      label.append(span);
    }
    label.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCollapsed(ownerOf(strip), groupId);
    });
    label.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanel({ owner: ownerOf(strip), groupId, anchor: label, creating: false });
    });
    slot.append(label);
    return slot;
  }

  function paintChip(slot, group, run, shown) {
    const label = slot.firstElementChild;
    const name = group.name.trim();
    const hidden = run.filter((tab) => !shown.includes(tab));
    setColor(slot, colorHex(group.color));
    setFlag(slot, "data-stg-last", shown.length === 0);
    setFlag(slot, "data-stg-collapsed", group.collapsed);
    setFlag(label, "data-unnamed", !name);
    setText(label.querySelector(".stg-label-name"), name);
    setText(label.querySelector(".stg-label-count"), group.collapsed ? `+${hidden.length}` : "");
    setFlag(label.querySelector(".stg-label-count"), "hidden", !group.collapsed || !hidden.length);
    // A collapsed group still says when something behind it needs you, the
    // way the tab itself would have.
    const badges = hidden.map((tab) => tab.button.querySelector("[role='img']")).filter(Boolean);
    const alert = label.querySelector(".stg-label-alert");
    setFlag(alert, "hidden", badges.length === 0);
    setFlag(
      alert,
      "data-dead",
      badges.some((badge) => /destructive/.test(badge.className)),
    );
    setAttr(label, "aria-expanded", String(!group.collapsed));
    const tabs = `${run.length} ${run.length === 1 ? "tab" : "tabs"}`;
    const verb = group.collapsed ? "expand" : "collapse";
    setAttr(label, "aria-label", `${groupName(group)}, tab group, ${tabs}`);
    setAttr(label, "title", `${groupName(group)} — ${tabs}\nClick to ${verb} · right-click to edit`);
  }

  // Runs as a microtask: after React's commit, before the browser paints, so
  // a label never flashes in the wrong place — and without waiting on a
  // frame, which a background tab may never get.
  let queued = false;
  function scheduleRender() {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      for (const strip of strips()) reconcileNow(strip);
    });
  }

  // Watch each strip SPAWN D renders; look for new ones (workspace switches,
  // split windows) on a slow timer rather than watching the whole page, which
  // terminals keep busy.
  const watched = new WeakSet();
  const stripObserver = new MutationObserver(scheduleRender);
  function scan() {
    for (const strip of strips()) {
      stateFor(ownerOf(strip));
      if (watched.has(strip)) continue;
      watched.add(strip);
      stripObserver.observe(strip, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "aria-selected",
          "data-workspace-tab",
          "data-workspace-tab-strip-owner",
          "data-dragging",
        ],
      });
    }
    scheduleRender();
  }

  // ---------------------------------------------------------------- actions

  const busy = new Set();
  let pendingNewTab = null;

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(test, timeout) {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      if (test()) return true;
      await wait(30);
    }
    return false;
  }

  /**
   * Walk a tab through the strip with SPAWN D's own Alt+Shift+Arrow reorder
   * until `direction(order)` says it is where it should be (0). One step at a
   * time, waiting for each to land, so every step is an ordinary save.
   */
  async function walkTab(owner, tabId, direction) {
    busy.add(owner);
    try {
      for (let step = 0; step < 24; step++) {
        const strip = stripFor(owner);
        if (!strip || !settled(strip)) break;
        const order = orderOf(strip);
        const delta = direction(order);
        if (!delta) break;
        const button = tabButton(owner, tabId);
        if (!button) break;
        const key = delta < 0 ? "ArrowLeft" : "ArrowRight";
        const before = order.join();
        button.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code: key,
            altKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
        );
        const moved = await waitFor(() => {
          const s = stripFor(owner);
          return Boolean(s) && orderOf(s).join() !== before;
        }, 2500);
        if (!moved) break;
      }
    } finally {
      busy.delete(owner);
      // The walk is ours: take the strip as it now stands without reading
      // the tabs it passed as moves.
      const state = states.get(owner);
      const strip = stripFor(owner);
      if (state && strip && settled(strip)) {
        state.order = orderOf(strip);
        keepContiguous(state, state.order);
        dropEmptyGroups(state);
        save(owner);
      }
      scheduleRender();
    }
  }

  /** Put a tab at the end of a group (where Firefox puts a tab you add). */
  function moveIntoGroup(owner, tabId, groupId) {
    const state = states.get(owner);
    if (!state?.groups[groupId]) return;
    state.member[tabId] = groupId;
    save(owner);
    scheduleRender();
    return walkTab(owner, tabId, (order) => {
      const others = order
        .map((id, i) => (id !== tabId && state.member[id] === groupId ? i : -1))
        .filter((i) => i >= 0);
      if (others.length === 0) return 0;
      const at = order.indexOf(tabId);
      const last = Math.max(...others);
      if (at === last + 1) return 0;
      return at < last ? 1 : -1;
    });
  }

  function newGroupWith(owner, tabId) {
    const state = states.get(owner);
    if (!state) return;
    const groupId = crypto.randomUUID();
    state.groups[groupId] = { name: "", color: nextColor(state), collapsed: false };
    state.member[tabId] = groupId;
    dropEmptyGroups(state);
    save(owner);
    const strip = stripFor(owner);
    if (strip) reconcileNow(strip);
    const anchor = strip?.querySelector(`[data-stg-label="${CSS.escape(groupId)}"] .stg-label`);
    // A tab pulled out of the middle of another group steps out of it first.
    const left = (order) => {
      const at = order.indexOf(tabId);
      const l = state.member[order[at - 1]];
      const r = state.member[order[at + 1]];
      return l && l === r ? 1 : 0;
    };
    walkTab(owner, tabId, left);
    openPanel({ owner, groupId, anchor: anchor ?? tabButton(owner, tabId), creating: true });
  }

  function removeFromGroup(owner, tabId) {
    const state = states.get(owner);
    const groupId = state?.member[tabId];
    if (!groupId) return;
    const rest = membersOf(state, groupId).filter((id) => id !== tabId);
    delete state.member[tabId];
    dropEmptyGroups(state);
    save(owner);
    scheduleRender();
    // Firefox moves a tab removed from the middle of a group to just past it.
    walkTab(owner, tabId, (order) => {
      const at = order.indexOf(tabId);
      const indexes = rest.map((id) => order.indexOf(id)).filter((i) => i >= 0);
      if (indexes.length === 0) return 0;
      return at > Math.min(...indexes) && at < Math.max(...indexes) ? 1 : 0;
    });
  }

  function ungroup(owner, groupId) {
    const state = states.get(owner);
    if (!state) return;
    for (const tabId of membersOf(state, groupId)) delete state.member[tabId];
    delete state.groups[groupId];
    save(owner);
    scheduleRender();
  }

  function toggleCollapsed(owner, groupId) {
    const group = states.get(owner)?.groups[groupId];
    if (!group) return;
    group.collapsed = !group.collapsed;
    save(owner);
    scheduleRender();
  }

  function newTabInGroup(owner, groupId) {
    const plus = stripFor(owner)?.querySelector("button[aria-label='New tab']");
    if (!plus || plus.disabled) return;
    const group = states.get(owner)?.groups[groupId];
    if (group?.collapsed) toggleCollapsed(owner, groupId);
    pendingNewTab = { owner, groupId, until: performance.now() + PENDING_NEW_TAB_MS };
    plus.click();
  }

  function reconcileNow(strip) {
    try {
      reconcile(strip);
    } catch (error) {
      console.warn("[spawn-tab-groups]", error);
    }
  }

  // ------------------------------------------------------------- icons

  // Lucide-style strokes, matching the icons in SPAWN D's own menus.
  const BOX = ["rect", { x: 3, y: 7, width: 18, height: 12, rx: 2 }];
  const ICONS = {
    group: [BOX, ["path", { d: "M3 4h18" }]],
    ungroup: [BOX, ["path", { d: "M3 4h6M15 4h6" }]],
    plus: [["path", { d: "M12 5v14M5 12h14" }]],
    chevron: [["path", { d: "m9 18 6-6-6-6" }]],
    collapse: [["path", { d: "m15 18-6-6 6-6" }]],
    expand: [["path", { d: "m9 18 6-6-6-6" }]],
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  function icon(shapes, className = "stg-icon") {
    const root = document.createElementNS(SVG_NS, "svg");
    const attrs = {
      class: className,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    };
    for (const [name, value] of Object.entries(attrs)) root.setAttribute(name, value);
    for (const [tag, shapeAttrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(shapeAttrs)) shape.setAttribute(name, value);
      root.append(shape);
    }
    return root;
  }

  // ---------------------------------------------------------- tab menu

  /** The tab last right-clicked, so its menu can be told which tab it is for. */
  let menuTarget = null;
  /** The tab last pressed, to break ties when a drag swaps two neighbours. */
  let lastPressed = null;

  document.addEventListener(
    "contextmenu",
    (event) => {
      const button = event.target.closest?.("[data-workspace-tab]");
      menuTarget = button
        ? {
            tabId: tabIdOf(button),
            owner: button.getAttribute("data-workspace-tab-owner"),
            at: performance.now(),
          }
        : null;
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      const button = event.target.closest?.("[data-workspace-tab]");
      if (button) lastPressed = { tabId: tabIdOf(button), at: performance.now() };
    },
    true,
  );

  let flyout = null;
  let flyoutTimer = 0;

  function closeFlyout() {
    clearTimeout(flyoutTimer);
    flyout?.el.remove();
    flyout?.parent.setAttribute("aria-expanded", "false");
    flyout = null;
  }

  // SPAWN D renders its menus into a portal on <body>; the tab's right-click
  // menu is the one that appears right after a right-click on a tab.
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && node.getAttribute("role") === "menu") {
          const target = menuTarget;
          if (target && performance.now() - target.at < 1500) {
            menuTarget = null;
            try {
              extendTabMenu(node, target);
            } catch (error) {
              console.warn("[spawn-tab-groups]", error);
            }
          }
        }
      }
      for (const node of record.removedNodes) {
        if (flyout && node === flyout.menu) closeFlyout();
      }
    }
  }).observe(document.body, { childList: true });

  function menuItem(sample, iconShapes, text, { submenu = false, dot = null } = {}) {
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.className = `${sample?.className ?? ""} stg-menuitem`;
    item.setAttribute("data-stg-item", "");
    if (dot) {
      const swatch = document.createElement("span");
      swatch.className = "stg-dot";
      swatch.style.setProperty("--stg-color", dot);
      item.append(swatch);
    } else if (iconShapes) {
      item.append(icon(iconShapes));
    }
    const label = document.createElement("span");
    label.className = "stg-menuitem-text";
    label.textContent = text;
    item.append(label);
    if (submenu) {
      item.setAttribute("aria-haspopup", "menu");
      item.setAttribute("aria-expanded", "false");
      item.append(icon(ICONS.chevron, "stg-icon stg-chevron"));
    }
    return item;
  }

  function extendTabMenu(menu, { owner, tabId }) {
    const state = states.get(owner);
    if (!state || !tabButton(owner, tabId)) return;
    const sample = menu.querySelector("[role='menuitem']");
    const own = state.member[tabId] ?? null;
    const others = Object.entries(state.groups).filter(([id]) => id !== own);
    const items = [];

    if (others.length === 0) {
      const item = menuItem(sample, ICONS.group, own ? "Move tab to new group" : "Add tab to new group");
      item.addEventListener("click", () => newGroupWith(owner, tabId));
      items.push(item);
    } else {
      const parent = menuItem(sample, ICONS.group, own ? "Move tab to group" : "Add tab to group", {
        submenu: true,
      });
      const entries = () => [
        { icon: ICONS.plus, text: "New group", run: () => newGroupWith(owner, tabId) },
        null,
        ...others.map(([groupId, group]) => ({
          dot: colorHex(group.color),
          text: groupName(group),
          run: () => moveIntoGroup(owner, tabId, groupId),
        })),
      ];
      const open = (focusFirst) => openFlyout(menu, parent, sample, entries(), focusFirst);
      // The parent only opens its submenu; it must not close SPAWN D's menu.
      parent.addEventListener("click", (event) => {
        event.stopPropagation();
        open(true);
      });
      parent.addEventListener("mouseenter", () => {
        clearTimeout(flyoutTimer);
        flyoutTimer = setTimeout(() => open(false), 120);
      });
      parent.addEventListener("mouseleave", () => {
        clearTimeout(flyoutTimer);
        flyoutTimer = setTimeout(() => {
          if (flyout && !flyout.el.matches(":hover")) closeFlyout();
        }, 250);
      });
      parent.addEventListener("keydown", (event) => {
        if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          open(true);
        }
      });
      items.push(parent);
    }

    if (own) {
      const item = menuItem(sample, ICONS.ungroup, "Remove from group");
      item.addEventListener("click", () => removeFromGroup(owner, tabId));
      items.push(item);
    }

    // Hovering any of SPAWN D's own rows closes the submenu, as a menu does.
    for (const row of menu.querySelectorAll("[role='menuitem']:not([data-stg-item])")) {
      row.addEventListener("mouseenter", closeFlyout);
    }

    // Our rows go after Duplicate/Rename, before the separator above Close.
    const separator = menu.querySelector("hr");
    const ours = document.createElement("hr");
    ours.className = separator?.className ?? "stg-sep";
    ours.setAttribute("data-stg-item", "");
    if (separator) {
      separator.before(ours, ...items);
    } else {
      menu.append(ours, ...items);
    }
  }

  function openFlyout(menu, parent, sample, entries, focusFirst) {
    if (flyout?.parent === parent) {
      if (focusFirst) flyout.el.querySelector("[role='menuitem']")?.focus();
      return;
    }
    closeFlyout();
    const el = document.createElement("div");
    el.setAttribute("role", "menu");
    el.className = `${menu.className} stg-flyout`;
    el.style.position = "fixed";
    el.style.visibility = "hidden";
    for (const entry of entries) {
      if (!entry) {
        const hr = document.createElement("hr");
        hr.className = menu.querySelector("hr")?.className ?? "stg-sep";
        el.append(hr);
        continue;
      }
      const item = menuItem(sample, entry.icon, entry.text, { dot: entry.dot });
      item.addEventListener("click", () => {
        closeFlyout();
        // Clicking SPAWN D's menu is what closes it.
        menu.click();
        entry.run();
      });
      el.append(item);
    }
    // SPAWN D closes its menu on any press outside it; this is still inside.
    el.addEventListener("pointerdown", (event) => event.stopPropagation());
    el.addEventListener("mouseenter", () => clearTimeout(flyoutTimer));
    el.addEventListener("mouseleave", () => {
      clearTimeout(flyoutTimer);
      flyoutTimer = setTimeout(() => {
        if (!parent.matches(":hover")) closeFlyout();
      }, 250);
    });
    el.addEventListener("keydown", (event) => {
      const rows = [...el.querySelectorAll("[role='menuitem']")];
      const at = rows.indexOf(document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        rows[(at + step + rows.length) % rows.length]?.focus();
      } else if (event.key === "ArrowLeft" || event.key === "Escape") {
        event.preventDefault();
        closeFlyout();
        parent.focus();
      } else {
        return;
      }
      event.stopPropagation();
    });
    document.body.append(el);
    const anchor = parent.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    let left = anchor.right + 4;
    if (left + box.width > window.innerWidth - 8) left = anchor.left - box.width - 4;
    let top = anchor.top - 5;
    if (top + box.height > window.innerHeight - 8) top = window.innerHeight - 8 - box.height;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${Math.max(8, top)}px`;
    el.style.visibility = "";
    parent.setAttribute("aria-expanded", "true");
    flyout = { el, parent, menu };
    if (focusFirst) el.querySelector("[role='menuitem']")?.focus();
  }

  // ------------------------------------------------------- group panel

  let panel = null;

  function closePanel({ cancel = false } = {}) {
    if (!panel) return;
    const current = panel;
    panel = null;
    current.cleanup();
    current.el.remove();
    if (cancel && current.creating) ungroup(current.owner, current.groupId);
    if (current.returnFocus?.isConnected) current.returnFocus.focus({ preventScroll: true });
  }

  /**
   * Firefox's tab group editor: "Create tab group" (with Cancel / Done) when a
   * group is born, "Manage tab group" (with the group's actions) when its
   * label is right-clicked. Name and colour apply as you change them.
   */
  function openPanel({ owner, groupId, anchor, creating }) {
    closePanel();
    const state = states.get(owner);
    const group = state?.groups[groupId];
    if (!group) return;

    const el = document.createElement("div");
    el.className = "stg-panel";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", creating ? "Create tab group" : "Manage tab group");

    const title = document.createElement("div");
    title.className = "stg-panel-title";
    title.textContent = creating ? "Create tab group" : "Manage tab group";

    const input = document.createElement("input");
    input.className = "stg-input";
    input.type = "text";
    input.placeholder = "Name";
    input.maxLength = 60;
    input.setAttribute("aria-label", "Group name");
    input.value = group.name;
    input.addEventListener("input", () => {
      group.name = input.value;
      save(owner);
      scheduleRender();
    });

    const swatches = document.createElement("div");
    swatches.className = "stg-swatches";
    swatches.setAttribute("role", "radiogroup");
    swatches.setAttribute("aria-label", "Group colour");
    const paintSwatches = () => {
      for (const swatch of swatches.children) {
        const on = swatch.dataset.color === group.color;
        swatch.setAttribute("aria-checked", String(on));
        swatch.tabIndex = on ? 0 : -1;
      }
    };
    for (const color of COLORS) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "stg-swatch";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-label", color.label);
      swatch.title = color.label;
      swatch.dataset.color = color.id;
      swatch.style.setProperty("--stg-color", color.hex);
      swatch.addEventListener("click", () => {
        group.color = color.id;
        paintSwatches();
        save(owner);
        scheduleRender();
      });
      swatch.addEventListener("keydown", (event) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const index = COLORS.findIndex((c) => c.id === group.color);
        const next = swatches.children[(index + step + COLORS.length) % COLORS.length];
        next.click();
        next.focus();
      });
      swatches.append(swatch);
    }
    paintSwatches();

    el.append(title, input, swatches);

    if (creating) {
      const footer = document.createElement("div");
      footer.className = "stg-footer";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "stg-btn";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => closePanel({ cancel: true }));
      const done = document.createElement("button");
      done.type = "button";
      done.className = "stg-btn stg-btn-primary";
      done.textContent = "Done";
      done.addEventListener("click", () => closePanel());
      footer.append(cancel, done);
      el.append(footer);
    } else {
      const hr = document.createElement("hr");
      hr.className = "stg-sep";
      el.append(hr);
      const action = (iconShapes, text, run, disabled = false) => {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "stg-action";
        row.disabled = disabled;
        row.append(icon(iconShapes));
        const span = document.createElement("span");
        span.textContent = text;
        row.append(span);
        row.addEventListener("click", () => {
          closePanel();
          run();
        });
        el.append(row);
      };
      const plus = stripFor(owner)?.querySelector("button[aria-label='New tab']");
      action(ICONS.plus, "New tab in group", () => newTabInGroup(owner, groupId), !plus || plus.disabled);
      action(
        group.collapsed ? ICONS.expand : ICONS.collapse,
        group.collapsed ? "Expand group" : "Collapse group",
        () => toggleCollapsed(owner, groupId),
      );
      action(ICONS.ungroup, "Ungroup tabs", () => ungroup(owner, groupId));
    }

    // Keys typed here are ours, not SPAWN D's shortcuts or a terminal's.
    const swallow = (event) => event.stopPropagation();
    el.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel({ cancel: true });
      } else if (event.key === "Enter" && event.target === input) {
        event.preventDefault();
        closePanel();
      }
      event.stopPropagation();
    });
    el.addEventListener("keyup", swallow);
    el.addEventListener("keypress", swallow);

    const onOutside = (event) => {
      if (!el.contains(event.target)) closePanel();
    };
    document.addEventListener("pointerdown", onOutside, true);

    panel = {
      el,
      owner,
      groupId,
      creating,
      returnFocus: document.activeElement,
      cleanup: () => document.removeEventListener("pointerdown", onOutside, true),
    };

    document.body.append(el);
    const rect = (anchor?.isConnected ? anchor : document.body).getBoundingClientRect();
    const box = el.getBoundingClientRect();
    let top = rect.bottom + 8;
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - box.height - 8);
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - box.width - 8);
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
    input.focus();
    input.select();
  }

  // ---------------------------------------------------------------- styles

  const style = document.createElement("style");
  style.id = "spawn-tab-groups-style";
  style.textContent = `
[data-stg] { position: relative; }
[data-stg]::before, .stg-slot::before {
  content: ""; position: absolute; top: -4px; left: 0; right: -4px; height: 2px;
  background: var(--stg-color); pointer-events: none;
}
.stg-slot::before { left: 2px; border-radius: 2px 0 0 2px; }
[data-stg][data-stg-last]::before { right: 0; border-radius: 0 2px 2px 0; }
.stg-slot[data-stg-last]::before { right: 2px; border-radius: 2px; }
[data-stg-hidden] { display: none !important; }

.stg-slot {
  position: relative; flex-shrink: 0; display: flex; align-items: center;
  height: 32px; padding: 0 2px; margin-right: -1px;
}
.stg-label {
  all: unset; box-sizing: border-box; display: inline-flex; align-items: center; gap: 4px;
  height: 20px; max-width: 160px; padding: 0 8px; border-radius: 6px; cursor: pointer;
  background: var(--stg-color); color: #111;
  font: 600 12px/20px ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.01em;
  transition: filter 120ms ease, transform 120ms ease;
}
.stg-label:hover { filter: brightness(1.1); }
.stg-label:active { transform: scale(0.97); }
.stg-label:focus-visible { outline: 2px solid var(--ring, #fff); outline-offset: 2px; }
.stg-label[data-unnamed] { min-width: 18px; padding: 0 5px; justify-content: center; }
.stg-label-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stg-label-name:empty { display: none; }
.stg-label-count {
  flex-shrink: 0; padding: 0 4px; border-radius: 4px; background: rgba(0,0,0,0.16);
  font-size: 10.5px; line-height: 15px; font-variant-numeric: tabular-nums;
}
.stg-label-alert {
  flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%;
  background: var(--warning, #f5a524); box-shadow: 0 0 0 1.5px #111;
}
.stg-label-alert[data-dead] { background: var(--destructive, #f2545b); }
.stg-label [hidden] { display: none; }

.stg-icon { width: 16px; height: 16px; flex-shrink: 0; }
.stg-menuitem-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stg-chevron { margin-left: auto; opacity: 0.6; }
.stg-menuitem[aria-expanded="true"] { background: var(--popover-accent, rgba(255,255,255,0.08)); }
.stg-dot {
  width: 10px; height: 10px; margin: 0 3px; border-radius: 50%; flex-shrink: 0;
  background: var(--stg-color);
}
.stg-sep { margin: 4px; height: 1px; border: 0; background: var(--popover-border, rgba(255,255,255,0.12)); }
.stg-flyout { z-index: 101 !important; max-width: 260px; }

.stg-panel {
  position: fixed; z-index: 120; width: 276px; box-sizing: border-box; padding: 12px;
  border-radius: 10px; border: 1px solid var(--popover-border, #333);
  background: var(--popover, #1d1d1d); color: var(--popover-foreground, #eee);
  box-shadow: 0 16px 40px rgba(0,0,0,0.5);
  font: 400 13px/1.4 ui-sans-serif, system-ui, sans-serif;
  animation: stg-in 110ms ease-out;
}
@keyframes stg-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
@media (prefers-reduced-motion: reduce) { .stg-panel { animation: none; } }
.stg-panel-title { font-weight: 600; margin: 0 0 10px; }
.stg-input {
  box-sizing: border-box; width: 100%; height: 32px; padding: 0 9px; border-radius: 6px;
  border: 1px solid var(--input, #3a3a3a); background: var(--background, #111);
  color: var(--foreground, #eee); font: inherit; outline: none;
}
.stg-input::placeholder { color: var(--muted-foreground, #888); }
.stg-input:focus { border-color: var(--ring, #ddd); }
.stg-swatches { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0 2px; }
.stg-swatch {
  all: unset; box-sizing: border-box; width: 22px; height: 22px; border-radius: 50%;
  background: var(--stg-color); cursor: pointer; transition: transform 100ms ease;
}
.stg-swatch:hover { transform: scale(1.1); }
.stg-swatch[aria-checked="true"] {
  box-shadow: 0 0 0 2px var(--popover, #1d1d1d), 0 0 0 4px var(--popover-foreground, #eee);
}
.stg-swatch:focus-visible { outline: 2px solid var(--ring, #fff); outline-offset: 4px; }
.stg-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.stg-btn {
  all: unset; box-sizing: border-box; height: 30px; padding: 0 12px; border-radius: 6px;
  cursor: pointer; font-weight: 500; font-size: 13px; line-height: 30px;
  color: var(--popover-foreground, #eee);
}
.stg-btn:hover { background: var(--popover-accent, rgba(255,255,255,0.08)); }
.stg-btn-primary { background: var(--primary, #eee); color: var(--primary-foreground, #111); }
.stg-btn-primary:hover { background: var(--primary, #eee); filter: brightness(0.92); }
.stg-btn:focus-visible, .stg-action:focus-visible { outline: 2px solid var(--ring, #fff); outline-offset: 1px; }
.stg-panel .stg-sep { margin: 12px -4px 4px; }
.stg-action {
  all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 7px 8px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.stg-action:hover { background: var(--popover-accent, rgba(255,255,255,0.08)); }
.stg-action:disabled { opacity: 0.45; cursor: default; background: none; }
`;
  (document.head ?? document.documentElement).append(style);

  scan();
  setInterval(scan, 800);
})();

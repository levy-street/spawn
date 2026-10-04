/**
 * The browser half of "a window keeps its identity when it moves": the warm
 * terminal for a window follows it to another host as a new Terminal on that
 * host, and only the device that moved it takes the display there and types.
 *
 * Rendered for real — React, React Query and the pool — with the Terminal
 * itself replaced by a stand-in that records how it was mounted and reports
 * transport and display state the way the real one does. Web unit tests run
 * under bun with no DOM, so a small one is put in place below: enough of
 * Node, Element and Document for React DOM to mount <div>s and portals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  forwardRef,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import type { Session } from "@/lib/api";
import type { DisplayControlState } from "@/lib/ws";
import type { SessionConnectionInfo } from "./ConnectionChip";
import type { TerminalHandle, TerminalProps } from "./Terminal";

// ---------- a DOM just big enough for React DOM ----------

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly ownerDocument: FakeDocument | null,
  ) {}
  get parentElement(): FakeNode | null {
    return this.parentNode;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  insertBefore(child: FakeNode, before: FakeNode | null): FakeNode {
    if (before === null) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  set textContent(_value: string) {
    for (const child of [...this.childNodes]) this.removeChild(child);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

class FakeElement extends FakeNode {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  constructor(tagName: string, ownerDocument: FakeDocument) {
    super(1, tagName.toUpperCase(), ownerDocument);
  }
  get tagName(): string {
    return this.nodeName;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
}

class FakeDocument extends FakeNode {
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  readonly activeElement = null;
  readonly visibilityState = "visible";
  defaultView: unknown = null;
  constructor() {
    super(9, "#document", null);
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
  }
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
  createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }
  createTextNode(): FakeNode {
    return new FakeNode(3, "#text", this);
  }
  hasFocus(): boolean {
    return false;
  }
}

const fakeDocument = new FakeDocument();
const fakeWindow = {
  document: fakeDocument,
  HTMLIFrameElement: class {},
  addEventListener() {},
  removeEventListener() {},
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
};
fakeDocument.defaultView = fakeWindow;

// ---------- the Terminal, as the pool sees it ----------

/** `props` are the latest, for the callbacks; the host and the claim are
 *  read at mount, as the real Terminal reads them. */
type Mount = {
  readonly props: TerminalProps;
  hostId: string | null;
  claimDisplayOnOpen: boolean;
  unmounted: boolean;
};
const mounts: Mount[] = [];
const typed: string[] = [];
/** Display claims a view was asked to make (`claimDisplay`). */
const claimed: string[] = [];

mock.module("./Terminal", () => {
  return {
    Terminal: forwardRef(function FakeTerminal(props: TerminalProps, ref: Ref<TerminalHandle>) {
      // Read at mount, as the real one reads them.
      const mountedWith = useRef({
        hostId: props.hostId,
        claimDisplayOnOpen: props.claimDisplayOnOpen ?? true,
      });
      const latest = useRef(props);
      latest.current = props;
      useImperativeHandle(
        ref,
        () =>
          ({
            sendInput: (bytes: Uint8Array | string) =>
              typed.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)),
            claimDisplay: () => claimed.push(latest.current.hostId ?? ""),
            focus: () => {},
          }) as unknown as TerminalHandle,
        [],
      );
      useEffect(() => {
        const entry: Mount = {
          get props() {
            return latest.current;
          },
          ...mountedWith.current,
          unmounted: false,
        };
        mounts.push(entry);
        return () => {
          entry.unmounted = true;
        };
      }, []);
      return null;
    }),
  };
});

// ---------- fixtures ----------

const WINDOW = "11111111-1111-4111-8111-111111111111";
const DREAM = "22222222-2222-4222-8222-222222222222";
const MAC = "33333333-3333-4333-8333-333333333333";

function row(hostId: string): Session {
  return {
    id: WINDOW,
    name: null,
    host_id: hostId,
    host_name: hostId === DREAM ? "dream" : "mac",
    cwd: "/repo",
    status: "running",
    started_at: "2026-10-03T00:00:00Z",
    exited_at: null,
    exit_code: null,
    last_output_at: null,
    last_input_at: null,
    last_activity_at: null,
    activity_state: "quiet",
    activity_label: "Quiet",
    foreground_command: "zsh",
    agent_id: null,
    agent_session_id: null,
  };
}

function open(hostId: string): SessionConnectionInfo {
  return { socketState: "open", v3: true, dcOpen: true, hostId } as SessionConnectionInfo;
}

function display(owner: boolean): DisplayControlState {
  return { owner, cols: 80, rows: 24, viewers: 2 };
}

type Modules = {
  act: typeof import("react").act;
  createElement: typeof import("react").createElement;
  useState: typeof import("react").useState;
  createRoot: typeof import("react-dom/client").createRoot;
  QueryClient: typeof import("@tanstack/react-query").QueryClient;
  QueryClientProvider: typeof import("@tanstack/react-query").QueryClientProvider;
  useQuery: typeof import("@tanstack/react-query").useQuery;
  provider: typeof import("./LiveTerminalProvider");
  drain: typeof import("@/hooks/usePendingLaunchDrain");
  incarnation: typeof import("./incarnation");
  pending: typeof import("@/components/workspace/pending-launch");
};
let m: Modules;
const saved: Record<string, unknown> = {};
const GLOBALS = ["window", "document", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame"];

beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  for (const key of GLOBALS) saved[key] = g[key];
  g.window = fakeWindow;
  g.document = fakeDocument;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
  const react = await import("react");
  const query = await import("@tanstack/react-query");
  m = {
    act: react.act,
    createElement: react.createElement,
    useState: react.useState,
    createRoot: (await import("react-dom/client")).createRoot,
    QueryClient: query.QueryClient,
    QueryClientProvider: query.QueryClientProvider,
    useQuery: query.useQuery,
    provider: await import("./LiveTerminalProvider"),
    drain: await import("@/hooks/usePendingLaunchDrain"),
    incarnation: await import("./incarnation"),
    pending: await import("@/components/workspace/pending-launch"),
  };
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const key of GLOBALS) {
    if (saved[key] === undefined) delete g[key];
    else g[key] = saved[key];
  }
});

beforeEach(() => {
  mounts.length = 0;
  typed.length = 0;
  claimed.length = 0;
  m.pending.pendingLaunch.clear(WINDOW);
  m.incarnation.openIntent.clear(m.incarnation.incarnationKey(WINDOW, MAC));
});

/** React Query tells its observers on a timer of its own; let it, inside the
 *  act that caused it, so the assertions see what a person would. */
async function settle(work: () => void): Promise<void> {
  await m.act(async () => {
    work();
    for (let tick = 0; tick < 3; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** One pane showing the window, wired as the workspace grid wires it: the
 *  pool's live terminal, and the drain that types a queued launch. */
async function renderPane(initialHost: string) {
  const { createElement: h, createRoot, QueryClient, QueryClientProvider, useQuery } = m;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["session", WINDOW], row(initialHost));
  const seen: { live: ReturnType<typeof m.provider.useLiveTerminal> | null } = { live: null };
  const shown = { set: (_visible: boolean) => {} };

  function Pane(): ReactNode {
    const live = m.provider.useLiveTerminal(WINDOW);
    const session = useQuery<Session>({
      queryKey: ["session", WINDOW],
      queryFn: () => Promise.reject(new Error("not fetched by the pane")),
      enabled: false,
    }).data;
    m.drain.usePendingLaunchDrain({
      sessionId: WINDOW,
      session,
      connInfo: live.connInfo,
      displayState: live.displayState,
      getHandle: live.getHandle,
    });
    seen.live = live;
    return h("div", { ref: live.attach });
  }

  /** The workspace around the pane: switching away parks its terminal in
   *  the pool, still connected, with no pane on screen. */
  function Screen(): ReactNode {
    const [visible, setVisible] = m.useState(true);
    shown.set = setVisible;
    return visible ? h(Pane) : null;
  }

  const root = createRoot(fakeDocument.createElement("div") as unknown as HTMLElement);
  await settle(() => {
    root.render(
      h(QueryClientProvider, { client }, h(m.provider.LiveTerminalProvider, null, h(Screen))),
    );
  });
  const current = () => {
    const mount = mounts.at(-1);
    if (!mount) throw new Error("no terminal mounted");
    return mount;
  };
  return {
    client,
    seen,
    current,
    /** The current terminal reports, as the real one does over its transport. */
    report: async (info: SessionConnectionInfo | null, owner?: boolean) => {
      await settle(() => {
        if (info) current().props.onConnectionInfo?.(info);
        if (owner !== undefined) current().props.onDisplayControl?.(display(owner));
      });
    },
    show: async (visible: boolean) => {
      await settle(() => shown.set(visible));
    },
    moveTo: async (hostId: string) => {
      await settle(() => {
        client.setQueryData(["session", WINDOW], row(hostId));
      });
    },
    unmount: async () => {
      await settle(() => root.unmount());
    },
  };
}

describe("a warm terminal whose window moves to another host", () => {
  test("is replaced by one on the new host that follows without taking control", async () => {
    const pane = await renderPane(DREAM);
    expect(mounts).toHaveLength(1);
    // Opened here: the first incarnation is an opening, and claims.
    expect(pane.current().hostId).toBe(DREAM);
    expect(pane.current().claimDisplayOnOpen).toBe(true);
    await pane.report(open(DREAM), true);
    expect(pane.seen.live?.connInfo?.hostId).toBe(DREAM);

    // Another device moved it.
    await pane.moveTo(MAC);
    expect(mounts).toHaveLength(2);
    expect(mounts[0].unmounted).toBe(true);
    expect(pane.current().unmounted).toBe(false);
    expect(pane.current().hostId).toBe(MAC);
    expect(pane.current().claimDisplayOnOpen).toBe(false);
    // What the old worker said about its transport and display went with it.
    expect(pane.seen.live?.connInfo).toBeNull();
    expect(pane.seen.live?.displayState).toBeNull();

    // A newer row naming the same host changes nothing: one remount per move.
    await pane.moveTo(MAC);
    expect(mounts).toHaveLength(2);
    await pane.unmount();
  });

  test("takes control and types the launch on the device that moved it", async () => {
    const pane = await renderPane(DREAM);
    await pane.report(open(DREAM), true);

    // What moveToHost does: the intent before the request, the launch for the
    // new host after the response, then the caches.
    const key = m.incarnation.incarnationKey(WINDOW, MAC);
    m.incarnation.openIntent.mark(key);
    m.pending.pendingLaunch.set(WINDOW, MAC, "claude --session-id new");
    await pane.moveTo(MAC);
    expect(pane.current().hostId).toBe(MAC);
    expect(pane.current().claimDisplayOnOpen).toBe(true);
    // Consumed by the terminal it was for, so a later move cannot inherit it.
    expect(m.incarnation.openIntent.has(key)).toBe(false);

    // Typed only once this view holds the new host's display.
    await pane.report(open(MAC), false);
    expect(typed).toEqual([]);
    await pane.report(null, true);
    expect(typed).toEqual(["claude --session-id new\r"]);
    await pane.report(open(MAC), true);
    expect(typed).toHaveLength(1);
    await pane.unmount();
  });

  test("never types a launch queued for the incarnation it left", async () => {
    const pane = await renderPane(DREAM);
    // A restart from this tab while another device held the display: the
    // resume waits for this view to take control.
    m.pending.pendingLaunch.set(WINDOW, DREAM, "claude --resume old");
    await pane.report(open(DREAM), false);
    expect(typed).toEqual([]);

    await pane.moveTo(MAC);
    // Followed, and later taken control of here: the resume was for dream's
    // shell and is not typed into mac's.
    await pane.report(open(MAC), true);
    expect(typed).toEqual([]);
    // And moving back does not revive it for dream's next shell.
    await pane.moveTo(DREAM);
    await pane.report(open(DREAM), true);
    expect(typed).toEqual([]);
    expect(m.pending.pendingLaunch.has(WINDOW, DREAM)).toBe(false);
    await pane.unmount();
  });
});

describe("a window put back by this device while another device holds its display", () => {
  const closed = (hostId: string) =>
    ({ socketState: "closed", v3: true, dcOpen: false, hostId }) as SessionConnectionInfo;
  const RESUME = "claude --resume 6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60 --permission-mode default";

  test("takes the display once on the restarted shell and types the resume", async () => {
    const pane = await renderPane(DREAM);
    // Another device has the display; the window is stopped while it moves.
    await pane.report(open(DREAM), false);
    await pane.report(closed(DREAM));
    // Resolve put it back from here: the resume is this device's to type.
    m.pending.pendingLaunch.claim(WINDOW, DREAM, RESUME);
    // The restarted worker attaches; the view claims rather than waits.
    await pane.report(open(DREAM), false);
    expect(claimed).toEqual([DREAM]);
    expect(typed).toEqual([]);
    // The claim lands: typed once, with its mode.
    await pane.report(null, true);
    expect(typed).toEqual([`${RESUME}\r`]);
    // Nothing left to claim for: losing the display later is not fought.
    await pane.report(null, false);
    expect(claimed).toEqual([DREAM]);
    await pane.unmount();
  });

  test("claims once per attachment, so a device that takes the display back is not fought", async () => {
    const pane = await renderPane(DREAM);
    await pane.report(closed(DREAM), false);
    m.pending.pendingLaunch.claim(WINDOW, DREAM, RESUME);
    await pane.report(open(DREAM), false);
    await pane.report(null, true);
    // Typed on the claim.
    expect(typed).toHaveLength(1);

    // A second claimed launch on the same attachment, the display elsewhere:
    // one claim for it, not one per display change.
    m.pending.pendingLaunch.claim(WINDOW, DREAM, RESUME);
    await pane.report(null, false);
    await pane.report(null, true);
    await pane.report(null, false);
    expect(claimed).toEqual([DREAM]);
    await pane.unmount();
  });

  test("an ordinary queued launch still waits for someone to take control", async () => {
    const pane = await renderPane(DREAM);
    await pane.report(closed(DREAM), false);
    m.pending.pendingLaunch.set(WINDOW, DREAM, "claude --resume old");
    await pane.report(open(DREAM), false);
    expect(claimed).toEqual([]);
    expect(typed).toEqual([]);
    await pane.unmount();
  });
});

describe("a parked terminal whose window moves", () => {
  test("follows it in the pool and drops the launch queued for the host it left", async () => {
    const pane = await renderPane(DREAM);
    m.pending.pendingLaunch.set(WINDOW, DREAM, "claude --resume old");
    await pane.report(open(DREAM), false);
    // Switched to another workspace: no pane, the terminal stays warm.
    await pane.show(false);
    expect(pane.current().unmounted).toBe(false);

    await pane.moveTo(MAC);
    expect(pane.current().hostId).toBe(MAC);
    expect(pane.current().claimDisplayOnOpen).toBe(false);
    await pane.moveTo(DREAM);
    expect(mounts).toHaveLength(3);

    // Back on screen, on dream's next shell, holding its display: nothing of
    // the old one's is typed.
    await pane.show(true);
    await pane.report(open(DREAM), true);
    expect(typed).toEqual([]);
    await pane.unmount();
  });
});

describe("a terminal that missed the move's data frame", () => {
  test("refetches the window's row once when a newer list names another host", async () => {
    const pane = await renderPane(DREAM);
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response(JSON.stringify(row(MAC)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      // The list is newer than the row and says the window runs on mac.
      await settle(() => {
        pane.client.setQueryData(["sessions"], [row(MAC)], {
          updatedAt: Date.now() + 1_000,
        });
      });
      await settle(() => {});
      expect(fetched).toEqual([`/api/sessions/${WINDOW}`]);
      // The row, not the list, moved the terminal — and the follower does not claim.
      expect(pane.current().hostId).toBe(MAC);
      expect(pane.current().claimDisplayOnOpen).toBe(false);
      expect(mounts).toHaveLength(2);
    } finally {
      globalThis.fetch = realFetch;
      await pane.unmount();
    }
  });

  test("is never moved by a list that predates the row", async () => {
    const pane = await renderPane(MAC);
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    try {
      // A list response that left the server before the move.
      await settle(() => {
        pane.client.setQueryData(["sessions"], [row(DREAM)], { updatedAt: 1 });
      });
      expect(fetched).toEqual([]);
      expect(pane.current().hostId).toBe(MAC);
      expect(mounts).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
      await pane.unmount();
    }
  });
});

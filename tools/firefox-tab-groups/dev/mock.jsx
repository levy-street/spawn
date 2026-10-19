// A stand-in for SPAWN D's workspace tab strip, close enough to its DOM and
// behaviour (web/src/components/workspace/workspace-tabs.tsx) to exercise the
// add-on without an account: the same data attributes, a portal context menu
// that closes on click / outside press / Escape, Alt+Shift+Arrow reorder,
// pointer-drag reorder with data-dragging, click-the-active-tab rename, and a
// "+" that asks what to open before making the tab.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";

const ITEM = "item";

const DropdownMenu = forwardRef(function DropdownMenu({ children }, ref) {
  const [point, setPoint] = useState(null);
  const menuRef = useRef(null);
  const close = () => setPoint(null);
  useImperativeHandle(ref, () => ({ openAt: (x, y) => setPoint({ x, y }) }), []);
  useEffect(() => {
    if (!point) return;
    const down = (event) => {
      if (!menuRef.current?.contains(event.target)) close();
    };
    const key = (event) => event.key === "Escape" && close();
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [point]);
  return point
    ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          onClick={close}
          style={{ position: "fixed", left: point.x, top: point.y }}
          className="menu"
        >
          {children}
        </div>,
        document.body,
      )
    : null;
});

let seq = 0;
const uid = () => `tab-${Date.now().toString(36)}-${++seq}`;
const makeTabs = (names) => names.map((name) => ({ id: uid(), name }));

const WORKSPACES = {
  "ws-alpha": { name: "alpha", tabs: makeTabs(["Build", "Tests", "Docs", "Server", "Logs"]) },
  "ws-beta": { name: "beta", tabs: makeTabs(["Main", "Scratch"]) },
};

export const patches = [];
// What the "server" holds, so switching workspaces and back keeps the order.
// Kept in sessionStorage so a reload finds the same tabs, as SPAWN D would.
const SERVER = JSON.parse(sessionStorage.getItem("mock-server") ?? "null") ??
  Object.fromEntries(
    Object.entries(WORKSPACES).map(([id, ws]) => [id, { active_tab: ws.tabs[0].id, tabs: ws.tabs }]),
  );

function WorkspaceTabs({ workspaceId, attention }) {
  const [layout, setLayout] = useState(() => SERVER[workspaceId]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const [renamingId, setRenamingId] = useState(null);
  const [draft, setDraft] = useState("");
  const [contextTabId, setContextTabId] = useState(null);
  const [newOpen, setNewOpen] = useState(false);
  const tabMenuRef = useRef(null);
  const wrappers = useRef(new Map());
  const dragged = useRef(false);

  // The optimistic PATCH: state now, "server" a beat later.
  const patch = (next) => {
    setLayout(next);
    SERVER[workspaceId] = next;
    sessionStorage.setItem("mock-server", JSON.stringify(SERVER));
    patches.push(next.tabs.map((t) => t.name).join(","));
  };
  const reorder = (tabId, to) => {
    const tabs = [...layoutRef.current.tabs];
    const from = tabs.findIndex((t) => t.id === tabId);
    to = Math.max(0, Math.min(tabs.length - 1, to));
    if (from === -1 || from === to) return;
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    patch({ ...layoutRef.current, tabs });
  };
  const nudge = (tabId, delta) => {
    const from = layoutRef.current.tabs.findIndex((t) => t.id === tabId);
    reorder(tabId, from + delta);
  };
  const addTab = () => {
    const names = new Set(layout.tabs.map((t) => t.name));
    let n = layout.tabs.length + 1;
    while (names.has(`Tab ${n}`)) n += 1;
    const tab = { id: uid(), name: `Tab ${n}` };
    patch({ active_tab: tab.id, tabs: [...layout.tabs, tab] });
  };
  const duplicate = (tabId) => {
    const at = layout.tabs.findIndex((t) => t.id === tabId);
    const tab = { id: uid(), name: `${layout.tabs[at].name} copy` };
    const tabs = [...layout.tabs];
    tabs.splice(at + 1, 0, tab);
    patch({ active_tab: tab.id, tabs });
  };
  const close = (tabId) => {
    if (layout.tabs.length <= 1) return;
    const index = layout.tabs.findIndex((t) => t.id === tabId);
    const tabs = layout.tabs.filter((t) => t.id !== tabId);
    const active = layout.active_tab === tabId ? tabs[Math.max(0, index - 1)].id : layout.active_tab;
    patch({ active_tab: active, tabs });
  };
  const submitRename = (tabId, event) => {
    event?.preventDefault();
    const name = draft.trim();
    if (name) patch({ ...layout, tabs: layout.tabs.map((t) => (t.id === tabId ? { ...t, name } : t)) });
    setRenamingId(null);
  };

  const armDrag = (tabId, event) => {
    dragged.current = false;
    if (event.button !== 0) return;
    const startX = event.clientX;
    let live = null;
    const move = (e) => {
      if (!live) {
        if (Math.abs(e.clientX - startX) < 4) return;
        const list = layoutRef.current.tabs;
        live = {
          from: list.findIndex((t) => t.id === tabId),
          slots: list.map((t) => {
            const r = wrappers.current.get(t.id).getBoundingClientRect();
            return r.left + r.width / 2;
          }),
          el: wrappers.current.get(tabId),
        };
        live.el.setAttribute("data-dragging", "true");
        dragged.current = true;
      }
      live.el.style.transform = `translateX(${e.clientX - startX}px)`;
      live.x = e.clientX;
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      if (!live) return;
      live.el.style.transform = "";
      live.el.removeAttribute("data-dragging");
      const x = live.x ?? startX;
      let to = live.slots.filter((mid) => mid < x).length;
      if (to > live.from) to -= 1;
      reorder(tabId, to);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up, { once: true });
  };

  return (
    <div
      role="tablist"
      aria-label="Workspace tabs"
      data-workspace-tab-strip
      data-workspace-tab-strip-owner={workspaceId}
      className="strip"
    >
      {layout.tabs.map((tab) => {
        const active = tab.id === layout.active_tab;
        if (renamingId === tab.id) {
          return (
            <div key={tab.id} className="relative shrink-0">
              <form onSubmit={(e) => submitRename(tab.id, e)} className={`tab ${active ? "active" : ""}`}>
                {/* biome-ignore lint/a11y/noAutofocus: mirrors SPAWN D */}
                <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => submitRename(tab.id)} />
              </form>
            </div>
          );
        }
        const badge = attention[tab.name];
        return (
          <div
            key={tab.id}
            ref={(el) => (el ? wrappers.current.set(tab.id, el) : wrappers.current.delete(tab.id))}
            className="relative shrink-0 wrap"
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              data-workspace-tab={tab.id}
              data-workspace-tab-owner={workspaceId}
              onPointerDown={(e) => armDrag(tab.id, e)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextTabId(tab.id);
                tabMenuRef.current.openAt(e.clientX, e.clientY);
              }}
              onKeyDown={(e) => {
                if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
                const d = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
                if (!d) return;
                e.preventDefault();
                e.stopPropagation();
                nudge(tab.id, d);
              }}
              onClick={() => {
                if (dragged.current) return void (dragged.current = false);
                if (active) {
                  setDraft(tab.name);
                  setRenamingId(tab.id);
                } else patch({ ...layout, active_tab: tab.id });
              }}
              className={`tab ${active ? "active" : ""}`}
            >
              {badge && (
                <span role="img" aria-label="waiting" className={`badge ${badge === "dead" ? "text-destructive" : ""}`}>
                  1
                </span>
              )}
              <span className="name">{tab.name}</span>
            </button>
            {layout.tabs.length > 1 && (
              <button type="button" aria-label={`Close ${tab.name}`} className="x" onClick={() => close(tab.id)}>
                ×
              </button>
            )}
          </div>
        );
      })}
      <div className="newwrap">
        <button type="button" aria-label="New tab" className="plus" disabled={layout.tabs.length >= 8} onClick={() => setNewOpen((v) => !v)}>
          +
        </button>
        {newOpen && (
          <div className="menu newmenu" role="menu">
            <button type="button" role="menuitem" className={ITEM} onClick={() => { setNewOpen(false); addTab(); }}>
              Shell
            </button>
            <button type="button" role="menuitem" className={ITEM} onClick={() => setNewOpen(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>
      <DropdownMenu ref={tabMenuRef}>
        <button type="button" role="menuitem" className={ITEM} onClick={() => duplicate(contextTabId)}>
          <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M4 16V5a1 1 0 0 1 1-1h11" /></svg>
          Duplicate tab
        </button>
        <button
          type="button"
          role="menuitem"
          className={ITEM}
          onClick={() => {
            const tab = layout.tabs.find((t) => t.id === contextTabId);
            setDraft(tab.name);
            setRenamingId(tab.id);
          }}
        >
          <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          Rename tab
        </button>
        <hr className="sep" />
        <button type="button" role="menuitem" className={`${ITEM} destructive`} onClick={() => close(contextTabId)}>
          <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></svg>
          Close tab
        </button>
      </DropdownMenu>
    </div>
  );
}

function App() {
  const [workspaceId, setWorkspaceId] = useState("ws-alpha");
  const [attention, setAttention] = useState({});
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">SPAWN D · mock</div>
        {Object.entries(WORKSPACES).map(([id, ws]) => (
          <button key={id} type="button" className={`ws ${id === workspaceId ? "on" : ""}`} onClick={() => setWorkspaceId(id)}>
            {ws.name}
          </button>
        ))}
        <button
          type="button"
          className="ws"
          id="toggle-attention"
          onClick={() => setAttention((a) => (a.Docs ? {} : { Docs: "waiting" }))}
        >
          Toggle attention on “Docs”
        </button>
      </aside>
      <main className="main">
        <WorkspaceTabs key={workspaceId} workspaceId={workspaceId} attention={attention} />
        <section className="panel">
          <div className="pane">
            <div className="pane-head">claude — ~/code/spawn</div>
            <pre className="term">{"$ claude\n> Right-click a tab to add it to a group.\n> Click a group's label to collapse it; right-click it to edit.\n"}</pre>
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
window.__mockPatches = patches;

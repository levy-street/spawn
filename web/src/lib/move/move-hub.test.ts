import { describe, expect, test } from "bun:test";
import {
  type HubBus,
  type HubClaims,
  type LocalLaunch,
  MoveHub,
  type MoveRecord,
} from "./move-hub";
import type { MoveLauncherPort, MoveOrchestrator, MovePlan, MoveView } from "./orchestrator";

/** BroadcastChannels of one browser: a message reaches every other end, later. */
class Bus {
  readonly ends: Array<HubBus & { closed: boolean }> = [];
  open(): HubBus {
    const end = {
      closed: false,
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (data: unknown) => {
        const copy = JSON.parse(JSON.stringify(data));
        for (const other of this.ends)
          if (other !== end && !other.closed)
            setTimeout(() => other.onmessage?.({ data: copy }), 0);
      },
      close: () => {
        end.closed = true;
      },
    };
    this.ends.push(end);
    return end;
  }
}

const TRANSFER = "44444444-4444-4444-8444-444444444444";
const SESSION = "33333333-3333-4333-8333-333333333333";
const TIMING = { heartbeatMs: 10, silenceMs: 60, handshakeMs: 30, acceptMs: 40, graceMs: 5 };

/** Web Locks of one browser: a claim one tab takes is that tab's for good. */
class Locks {
  readonly holders = new Map<string, string>();
  for(tab: string): HubClaims {
    return {
      take: async (name) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const holder = this.holders.get(name);
        if (holder !== undefined) return holder === tab;
        this.holders.set(name, tab);
        return true;
      },
    };
  }
}

function plan(): MovePlan {
  return {
    transferId: TRANSFER,
    sessionId: SESSION,
    agent: { kind: "claude-code", command: "claude", env: {} },
    conversationId: "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60",
    source: { hostId: "src", name: "dream", os: "linux", cwd: "/a" },
    target: { hostId: "dst", name: "mac", os: "darwin", cwd: "/b" },
    state: "idle",
    permissionMode: "default",
    targetShell: "/bin/zsh",
    memoryPath: null,
    wasRunning: true,
  };
}

function record(): Omit<MoveRecord, "runner" | "requester" | "view"> {
  return {
    transferId: TRANSFER,
    sessionId: SESSION,
    sourceHostId: "src",
    sourceName: "dream",
    targetHostId: "dst",
    targetName: "mac",
    targetCwd: "/b",
    conversationId: "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60",
    state: "idle",
  };
}

/** An orchestrator that moves straight to the commit and asks to type. */
function stubRun(log: string[], tab: string) {
  return (p: MovePlan, launcher: MoveLauncherPort, emit: (view: MoveView) => void) => {
    const view = (phase: MoveView["phase"]): MoveView => ({
      transferId: p.transferId,
      sessionId: p.sessionId,
      phase,
      bytes: 0,
      total: 0,
      failure: null,
      detail: null,
      outcome: phase === "moved" ? "moved" : null,
      conflicts: false,
      actions: [],
    });
    return {
      start: async () => {
        log.push(`${tab}:run`);
        emit(view("copying"));
        await new Promise((resolve) => setTimeout(resolve, 5));
        await launcher.prepare({ line: "claude --resume x", note: null });
        emit(view("moved"));
      },
      cancel: async () => {
        log.push(`${tab}:cancel`);
      },
      retry: async () => {},
      resumeOnSource: async () => {},
    } as unknown as MoveOrchestrator;
  };
}

function local(log: string[], tab: string): LocalLaunch {
  return {
    prepare: async () => {
      log.push(`${tab}:prepare`);
    },
    abandon: () => log.push(`${tab}:abandon`),
    restartOnSource: async () => {
      log.push(`${tab}:restart`);
    },
    refetch: () => {},
  };
}

function hub(
  bus: Bus | null,
  tab: string,
  owner: string | null,
  log: string[],
  extra: { locks?: Locks; local?: LocalLaunch } = {},
) {
  return new MoveHub({
    tabId: tab,
    bus: bus?.open() ?? null,
    ownerOf: () => owner,
    createRun: stubRun(log, tab),
    local: extra.local ?? local(log, tab),
    claims: extra.locks?.for(tab) ?? null,
    onChange: () => {},
    timing: TIMING,
  });
}

/** A tab that does what it is asked only after `ms`: busy, or throttled. */
function slow(log: string[], tab: string, ms: number): LocalLaunch {
  const wait = () => new Promise((resolve) => setTimeout(resolve, ms));
  return {
    prepare: async () => {
      await wait();
      log.push(`${tab}:prepare`);
    },
    abandon: () => log.push(`${tab}:abandon`),
    restartOnSource: async () => {
      await wait();
      log.push(`${tab}:restart`);
    },
    refetch: () => {},
  };
}

/** A bus end that holds every message for `ms` first: a frozen tab. */
function frozen(bus: Bus, ms: number): HubBus {
  const end = bus.open();
  let handler: ((event: { data: unknown }) => void) | null = null;
  Object.defineProperty(end, "onmessage", {
    get: () =>
      handler ? (event: { data: unknown }) => setTimeout(() => handler?.(event), ms) : null,
    set: (next) => {
      handler = next;
    },
  });
  return end;
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe("MoveHub", () => {
  test("without a bus, or as the owner, the move runs and types here", async () => {
    const log: string[] = [];
    const alone = hub(null, "A", "B", log);
    alone.start(plan(), record());
    await settle();
    expect(log).toEqual(["A:run", "A:prepare"]);
    expect(alone.forSession(SESSION)).toMatchObject({ mine: true, lost: false });
    expect(alone.forSession(SESSION)?.view.phase).toBe("moved");
    alone.close();
  });

  test("handed to the owner: it runs there, and the tab that asked types", async () => {
    const bus = new Bus();
    const log: string[] = [];
    const asking = hub(bus, "A", "B", log);
    const owner = hub(bus, "B", "B", log);
    asking.start(plan(), record());
    await settle();
    expect(log).toEqual(["B:run", "A:prepare"]);
    expect(asking.forSession(SESSION)).toMatchObject({ mine: true, runner: "B", requester: "A" });
    expect(asking.forSession(SESSION)?.view.phase).toBe("moved");
    asking.close();
    owner.close();
  });

  test("the asking tab gone: the owner types itself", async () => {
    const bus = new Bus();
    const log: string[] = [];
    const asking = hub(bus, "A", "B", log);
    const owner = hub(bus, "B", "B", log);
    asking.start(plan(), record());
    await settle(2);
    asking.close();
    bus.ends[0]!.closed = true;
    await settle(100);
    expect(log).toEqual(["B:run", "B:prepare"]);
    owner.close();
  });

  test("an owner that never answers: the move runs here", async () => {
    const bus = new Bus();
    const log: string[] = [];
    const asking = hub(bus, "A", "Z", log);
    asking.start(plan(), record());
    await settle(100);
    expect(log).toEqual(["A:run", "A:prepare"]);
    asking.close();
  });

  test.each([
    ["with Web Locks", true],
    ["without them", false],
  ])("an asking tab slow to queue the relaunch: exactly one tab queues it (%s)", async (_, withLocks) => {
    // The reviewers' interleaving: the asking tab answers `prepare` later
    // than the handshake; the runner used to queue it too, and both tabs
    // then typed the line, the second into the running Claude.
    const bus = new Bus();
    const log: string[] = [];
    const locks = withLocks ? new Locks() : undefined;
    // The asking tab hears the prepare well within its deadline and takes
    // three times as long as the handshake to queue the line.
    const timing = { ...TIMING, handshakeMs: 100 };
    const asking = new MoveHub({
      tabId: "A",
      bus: bus.open(),
      ownerOf: () => "B",
      createRun: stubRun(log, "A"),
      local: slow(log, "A", 300),
      claims: locks?.for("A") ?? null,
      onChange: () => {},
      timing,
    });
    const owner = new MoveHub({
      tabId: "B",
      bus: bus.open(),
      ownerOf: () => "B",
      createRun: stubRun(log, "B"),
      local: local(log, "B"),
      claims: locks?.for("B") ?? null,
      onChange: () => {},
      timing,
    });
    asking.start(plan(), record());
    await settle(600);
    expect(log.filter((line) => line.endsWith(":prepare"))).toEqual(["A:prepare"]);
    asking.close();
    owner.close();
  });

  test("a frozen asking tab that wakes after the deadline queues nothing: the runner did", async () => {
    const bus = new Bus();
    const log: string[] = [];
    const locks = new Locks();
    const asking = new MoveHub({
      tabId: "A",
      bus: frozen(bus, 120),
      ownerOf: () => "B",
      createRun: stubRun(log, "A"),
      local: local(log, "A"),
      claims: locks.for("A"),
      onChange: () => {},
      timing: { ...TIMING, acceptMs: 400 },
    });
    const owner = hub(bus, "B", "B", log, { locks });
    asking.start(plan(), record());
    await settle(400);
    expect(log.filter((line) => line.endsWith(":prepare"))).toEqual(["B:prepare"]);
    asking.close();
    owner.close();
  });

  test("a restart on the source is done by exactly one tab", async () => {
    const bus = new Bus();
    const log: string[] = [];
    const locks = new Locks();
    const restarting = (tab: string) => (_plan: MovePlan, launcher: MoveLauncherPort) =>
      ({
        start: async () => {
          log.push(`${tab}:run`);
          await launcher.restartOnSource();
        },
      }) as unknown as MoveOrchestrator;
    const timing = { ...TIMING, handshakeMs: 100 };
    const asking = new MoveHub({
      tabId: "A",
      bus: bus.open(),
      ownerOf: () => "B",
      createRun: restarting("A"),
      local: slow(log, "A", 300),
      claims: locks.for("A"),
      onChange: () => {},
      timing,
    });
    const owner = new MoveHub({
      tabId: "B",
      bus: bus.open(),
      ownerOf: () => "B",
      createRun: restarting("B"),
      local: local(log, "B"),
      claims: locks.for("B"),
      onChange: () => {},
      timing,
    });
    asking.start(plan(), record());
    await settle(600);
    expect(log.filter((line) => line.endsWith(":restart"))).toEqual(["A:restart"]);
    asking.close();
    owner.close();
  });

  test("a submit an owner hears after its deadline is never run again", async () => {
    // A frozen owner wakes to a submit the asking tab has run itself since.
    const bus = new Bus();
    const log: string[] = [];
    const locks = new Locks();
    const owner = new MoveHub({
      tabId: "B",
      bus: frozen(bus, 150),
      ownerOf: () => "B",
      createRun: stubRun(log, "B"),
      local: local(log, "B"),
      claims: locks.for("B"),
      onChange: () => {},
      timing: TIMING,
    });
    const asking = hub(bus, "A", "B", log, { locks });
    asking.start(plan(), record());
    await settle(300);
    expect(log.filter((line) => line.endsWith(":run"))).toEqual(["A:run"]);
    asking.close();
    owner.close();
  });

  test("a third tab hears the move, and a runner that says goodbye leaves it lost", async () => {
    const bus = new Bus();
    const log: string[] = [];
    const slow = new MoveHub({
      tabId: "B",
      bus: bus.open(),
      ownerOf: () => "B",
      createRun: (p, _launcher, emit) =>
        ({
          start: async () => {
            emit({
              transferId: p.transferId,
              sessionId: p.sessionId,
              phase: "copying",
              bytes: 1,
              total: 2,
              failure: null,
              detail: null,
              outcome: null,
              conflicts: false,
              actions: ["cancel"],
            });
          },
          cancel: async () => {
            log.push("B:cancel");
          },
        }) as unknown as MoveOrchestrator,
      local: local(log, "B"),
      onChange: () => {},
      timing: TIMING,
    });
    const asking = hub(bus, "A", "B", log);
    const watching = hub(bus, "C", "B", log);
    asking.start(plan(), record());
    await settle(30);
    expect(watching.forSession(SESSION)).toMatchObject({
      mine: false,
      lost: false,
      targetName: "mac",
    });
    expect(watching.forSession(SESSION)?.view.phase).toBe("copying");
    asking.control(TRANSFER, "cancel");
    await settle(10);
    expect(log).toContain("B:cancel");
    slow.close();
    await settle(10);
    expect(asking.forSession(SESSION)?.lost).toBe(true);
    expect(watching.forSession(SESSION)?.lost).toBe(true);
    asking.close();
    watching.close();
  });
});

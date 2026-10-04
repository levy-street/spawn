jest.mock("@/terminal/HostTransportSurface", () => ({ HostTransportSurface: () => null }));

import { unfinishedMoveRows } from "@/components/hosts/cockpit/unfinished-moves-panel";
import { makeSession } from "@/components/workspace-detail/__tests__/fixtures";
import type { ConversationTransfers } from "@/terminal/transport/conversation-codec";

/**
 * The host page's unfinished moves: the browser's four row kinds, and never
 * a Resolve on a move this phone is carrying right now.
 */

const HOST = "11111111-1111-4111-8111-111111111111";
const MAC = "22222222-2222-4222-8222-222222222222";
const names = new Map([
  [HOST, "dream"],
  [MAC, "mac"],
]);
const hostName = (id: string | null) => (id ? names.get(id) : null) ?? "another host";

const moving = makeSession({ id: "w-moving", host_id: HOST, status: "moving", name: "api" });
const settled = makeSession({ id: "w-settled", host_id: MAC, status: "running" });
const bare = makeSession({ id: "w-bare", host_id: HOST, status: "moving", name: "web" });

const transfers: ConversationTransfers = {
  outgoing: [
    {
      transferId: "t-out",
      conversationId: "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60",
      sessionId: "w-moving",
      toHostId: MAC,
      state: "moving",
      createdAt: 1,
      length: 25_000,
      sha256: null,
    },
    {
      transferId: "t-left",
      conversationId: "aaaaaaaa-0b7d-4c55-8f3e-2d9a1b7c4e60",
      sessionId: "w-settled",
      toHostId: MAC,
      state: "stranded",
      createdAt: 2,
      length: null,
      sha256: null,
    },
  ],
  incoming: [
    {
      transferId: "t-in",
      conversationId: "bbbbbbbb-0b7d-4c55-8f3e-2d9a1b7c4e60",
      fromHostId: MAC,
      state: "receiving",
      received: 0,
      nextSequence: 0,
      length: 1024,
      createdAt: 3,
    },
  ],
  truncated: false,
};

describe("unfinished moves on a host's page", () => {
  it("lists the browser's four kinds, with what Resolve acts on", () => {
    const rows = unfinishedMoveRows({
      hostId: HOST,
      transfers,
      sessions: [moving, settled, bare],
      underWay: new Set(),
      hostName,
      windowTitle: (session) => session.name ?? "",
    });
    expect(rows.map((row) => [row.title, row.subtitle, row.target?.kind ?? null])).toEqual([
      ["Conversation 6f1c2a9e moving to mac", "24 KB", "window"],
      ["Conversation aaaaaaaa couldn't be put back whole", null, "leftover"],
      ["Conversation bbbbbbbb arriving from mac", "1.0 KB", "incoming"],
      ["web · Moving to another host…", null, "window"],
    ]);
  });

  it("offers no Resolve on a move this phone is carrying now", () => {
    const rows = unfinishedMoveRows({
      hostId: HOST,
      transfers,
      sessions: [moving, settled, bare],
      underWay: new Set(["t-out", "w-moving", "t-in", "w-bare"]),
      hostName,
      windowTitle: (session) => session.name ?? "",
    });
    expect(rows.map((row) => [row.key, row.target?.kind ?? null])).toEqual([
      ["t-out", null],
      ["t-left", "leftover"],
      ["t-in", null],
      ["w-bare", null],
    ]);
  });
});

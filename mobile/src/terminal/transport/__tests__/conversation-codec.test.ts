import {
  type ConversationInspection,
  parseConversationCommitted,
  parseConversationExport,
  parseConversationImportOpened,
  parseConversationInspection,
  parseConversationProbe,
  parseConversationTransferStatus,
  parseConversationTransfers,
  parseRetireAnswer,
  probeSaysLive,
} from "@/terminal/transport/conversation-codec";

const answer: ConversationInspection = {
  agent: "claude-code",
  conversation_id: "4e0b4642-0972-40ac-9a18-61d542276b76",
  state: "blocked",
  cli_version: "2.1.288",
  live_elsewhere: false,
  source: "registry",
};

describe("parseConversationInspection", () => {
  test("reads a daemon's answer as it is", () => {
    expect(parseConversationInspection(answer)).toEqual(answer);
    const nothing: ConversationInspection = {
      agent: null,
      conversation_id: null,
      state: "unknown",
      cli_version: null,
      live_elsewhere: false,
      source: "none",
    };
    expect(parseConversationInspection(nothing)).toEqual(nothing);
  });

  test("an id from the host in upper case is read lower-case", () => {
    expect(
      parseConversationInspection({
        ...answer,
        conversation_id: "4E0B4642-0972-40AC-9A18-61D542276B76",
      }).conversation_id,
    ).toBe("4e0b4642-0972-40ac-9a18-61d542276b76");
  });

  test("a state this app does not know yet reads as unknown, not as malformed", () => {
    expect(parseConversationInspection({ ...answer, state: "compacting" }).state).toBe("unknown");
  });

  test("anything else malformed is refused", () => {
    for (const bad of [
      null,
      [],
      "registry",
      { ...answer, live_elsewhere: "no" },
      { ...answer, source: 7 },
      { ...answer, conversation_id: "../../etc/passwd" },
      { ...answer, conversation_id: "x".repeat(65) },
      { ...answer, conversation_id: "--dangerously-skip-permissions" },
      { ...answer, conversation_id: "-p" },
      { ...answer, conversation_id: "conv-2" },
      { ...answer, conversation_id: 7 },
      { ...answer, agent: 3 },
      { ...answer, cli_version: "2.1.288 && rm -rf /" },
    ]) {
      expect(() => parseConversationInspection(bad)).toThrow(
        "Host returned an invalid conversation report.",
      );
    }
  });
});

describe("the carrier's answers (conv.v2)", () => {
  const transferId = "9b2f5c1e-7a40-4d3b-8e61-0c4f2a7d9e15";
  const conversationId = "6f1c2a9e-0b7d-4c55-8f3e-2d9a1b7c4e60";

  test("a probe whose duplicate is live says the import would be refused", () => {
    const probe = parseConversationProbe({
      cwd: "/Users/me/code/spawn",
      folder_exists: true,
      store_ready: true,
      duplicates: [{ folder: "-x", path: "~/.claude/projects/-x/a.jsonl", size: 5, live: true }],
      live: null,
    });
    expect(probeSaysLive(probe)).toBe(true);
    expect(probeSaysLive({ ...probe, duplicates: [], live: false })).toBe(false);
    expect(() => parseConversationProbe({ folder_exists: true })).toThrow();
  });

  test("a probe says where claude resolves, apart from its version", () => {
    const base = { folder_exists: true, store_ready: true };
    const claude = (fields: Record<string, unknown>) => {
      const probe = parseConversationProbe({ ...base, ...fields });
      return { cliPath: probe.cliPath, cliVersion: probe.cliVersion };
    };
    // Missing: nothing found, and a daemon from before `cli_path` reads the same.
    expect(claude({ cli_path: null, cli_version: null })).toEqual({
      cliPath: null,
      cliVersion: null,
    });
    expect(claude({ cli_version: null })).toEqual({ cliPath: null, cliVersion: null });
    // Found, with its version.
    expect(claude({ cli_path: "/Users/me/.local/bin/claude", cli_version: "2.1.289" })).toEqual({
      cliPath: "/Users/me/.local/bin/claude",
      cliVersion: "2.1.289",
    });
    // Found, version unknown: a path, not a missing Claude Code.
    expect(claude({ cli_path: "/opt/spawn/claude", cli_version: null })).toEqual({
      cliPath: "/opt/spawn/claude",
      cliVersion: null,
    });
    // Anything but a path is ignored, never refused.
    for (const odd of [42, true, "", ["/opt/spawn/claude"], { path: "/opt/spawn/claude" }]) {
      expect(claude({ cli_path: odd, cli_version: null }).cliPath).toBeNull();
    }
  });

  test("an export answer must be a retire of the transfer asked for", () => {
    const answer = {
      stream_id: "rs-1",
      transfer_id: transferId,
      mode: "retire",
      length: 16753,
      sha256: null,
      window: 16,
      next_sequence: 0,
      entries: 3,
      skipped: 1,
      stopped: "lingering",
    };
    expect(parseConversationExport(answer)).toMatchObject({
      streamId: "rs-1",
      sha256: null,
      stopped: "lingering",
    });
    expect(parseConversationExport({ ...answer, stopped: "sideways" }).stopped).toBe("unknown");
    expect(() => parseConversationExport({ ...answer, mode: "snapshot" })).toThrow();
    expect(() => parseConversationExport({ ...answer, window: 0 })).toThrow();
    expect(() => parseConversationExport({ ...answer, sha256: "nope" })).toThrow();
  });

  test("statuses, commits and listings read as stream v2 says", () => {
    expect(
      parseConversationTransferStatus({ state: "committed", received: 9, next_sequence: 1 }),
    ).toEqual({
      state: "committed",
      received: 9,
      nextSequence: 1,
    });
    expect(() =>
      parseConversationTransferStatus({ state: "finished", received: 0, next_sequence: 0 }),
    ).toThrow();
    expect(
      parseConversationCommitted({
        transfer_id: transferId,
        conversation_id: conversationId.toUpperCase(),
        cwd: "/Users/me/code/spawn",
        memory: "~/.claude/projects/-Users-me-code-spawn/memory",
        set_aside: 1,
      }),
    ).toEqual({
      transferId,
      conversationId,
      cwd: "/Users/me/code/spawn",
      memory: "~/.claude/projects/-Users-me-code-spawn/memory",
      setAside: 1,
    });
    expect(parseConversationImportOpened({ stream_id: "w", window: 4, next_sequence: 2 })).toEqual({
      streamId: "w",
      window: 4,
      nextSequence: 2,
      received: 0,
    });
    expect(parseRetireAnswer({ state: "aborted", restored: 2 })).toEqual({
      state: "aborted",
      restored: 2,
    });
    expect(() => parseRetireAnswer({ state: "pending" })).toThrow();
    const listed = parseConversationTransfers({
      outgoing: [
        {
          transfer_id: transferId,
          conversation_id: conversationId,
          session_id: "33333333-3333-4333-8333-333333333333",
          to_host_id: "44444444-4444-4444-8444-444444444444",
          state: "stranded",
          created_at: 1,
          length: null,
          sha256: null,
        },
      ],
      incoming: [],
      truncated: true,
    });
    expect(listed.outgoing[0]).toMatchObject({ state: "stranded", length: null, sha256: null });
    expect(listed.truncated).toBe(true);
    expect(() =>
      parseConversationTransfers({ outgoing: [{ transfer_id: "nope" }], incoming: [] }),
    ).toThrow();
  });
});

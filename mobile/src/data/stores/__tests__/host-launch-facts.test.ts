import {
  forgetHostLaunchFacts,
  hostLaunchFacts,
  NO_LAUNCH_FACTS,
  parseHostLaunchFacts,
  recordHostLaunchFacts,
} from "@/data/stores/host-launch-facts";

afterEach(() => forgetHostLaunchFacts());

describe("parseHostLaunchFacts", () => {
  test("only an explicit yes from the host adds the flag", () => {
    expect(parseHostLaunchFacts({ codex: { no_daemon: true } })).toEqual({ codexNoDaemon: true });
    for (const agents of [
      undefined,
      null,
      "codex",
      [],
      {},
      { codex: null },
      { codex: { no_daemon: false } },
      { codex: { no_daemon: "true" } },
      { codex: { no_daemon: 1 } },
      { claude: { no_daemon: true } },
    ]) {
      expect(parseHostLaunchFacts(agents)).toEqual(NO_LAUNCH_FACTS);
    }
  });
});

describe("hostLaunchFacts", () => {
  test("is what each host last said, and nothing for one not heard from", () => {
    expect(hostLaunchFacts("host-a")).toEqual(NO_LAUNCH_FACTS);
    expect(hostLaunchFacts(null)).toEqual(NO_LAUNCH_FACTS);
    recordHostLaunchFacts("host-a", { codexNoDaemon: true });
    expect(hostLaunchFacts("host-a")).toEqual({ codexNoDaemon: true });
    expect(hostLaunchFacts("host-b")).toEqual(NO_LAUNCH_FACTS);
    // A later hello that says nothing (an older daemon) takes it back.
    recordHostLaunchFacts("host-a", parseHostLaunchFacts(undefined));
    expect(hostLaunchFacts("host-a")).toEqual(NO_LAUNCH_FACTS);
  });
});

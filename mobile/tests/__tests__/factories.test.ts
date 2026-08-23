import {
  FIXTURE_IDS,
  makeAgent,
  makeHost,
  makeSession,
  makeTab,
  makeWorkspace,
} from "../factories";

describe("shared fixture factories", () => {
  it("builds a coherent default domain graph", () => {
    const agent = makeAgent();
    const host = makeHost();
    const session = makeSession();
    const workspace = makeWorkspace();

    expect(agent.id).toBe(FIXTURE_IDS.agent);
    expect(session.host_id).toBe(host.id);
    expect(workspace.host_id).toBe(host.id);
    expect(workspace.layout.active_tab).toBe(FIXTURE_IDS.tab);
    expect(workspace.layout.tabs[0]).toEqual(makeTab());
  });

  it("applies overrides without sharing mutable nested values", () => {
    const first = makeWorkspace({ name: "First" });
    const second = makeWorkspace({ name: "Second" });
    const customSession = makeSession({ status: "exited", exit_code: 0 });

    expect(first.name).toBe("First");
    expect(second.name).toBe("Second");
    expect(first.layout).not.toBe(second.layout);
    expect(first.layout.tabs).not.toBe(second.layout.tabs);
    expect(first.layout.tabs[0]).not.toBe(second.layout.tabs[0]);
    expect(customSession).toMatchObject({ status: "exited", exit_code: 0 });
  });
});

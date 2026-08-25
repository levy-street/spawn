import { execSync } from "node:child_process";
import type { ConfigContext } from "expo/config";
import appConfig from "../app.config";

jest.mock("node:child_process", () => ({ execSync: jest.fn() }));

const context = { config: {} } as ConfigContext;

describe("app config release identity", () => {
  const originalTree = process.env["EXPO_PUBLIC_SPAWN_MOBILE_TREE"];

  afterEach(() => {
    if (originalTree === undefined) delete process.env["EXPO_PUBLIC_SPAWN_MOBILE_TREE"];
    else process.env["EXPO_PUBLIC_SPAWN_MOBILE_TREE"] = originalTree;
    jest.mocked(execSync).mockReset();
  });

  it("prefers the tree stamped by the release script", () => {
    process.env["EXPO_PUBLIC_SPAWN_MOBILE_TREE"] = " stamped-tree ";
    expect(appConfig(context).extra?.["mobileTree"]).toBe("stamped-tree");
    expect(execSync).not.toHaveBeenCalled();
  });

  it("falls back to the mobile git tree and tolerates git being unavailable", () => {
    delete process.env["EXPO_PUBLIC_SPAWN_MOBILE_TREE"];
    jest.mocked(execSync).mockReturnValueOnce("git-tree\n");
    expect(appConfig(context).extra?.["mobileTree"]).toBe("git-tree");
    expect(execSync).toHaveBeenCalledWith(
      "git rev-parse HEAD:mobile",
      expect.objectContaining({ encoding: "utf8" }),
    );

    jest.mocked(execSync).mockImplementationOnce(() => {
      throw new Error("git unavailable");
    });
    expect(appConfig(context).extra?.["mobileTree"]).toBeUndefined();
  });
});

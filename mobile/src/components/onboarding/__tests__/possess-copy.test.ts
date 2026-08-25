import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const POST_INSTALL_SURFACES = [
  "src/components/onboarding/install-instructions.tsx",
  "src/components/onboarding/pairing-code-entry.tsx",
  "src/components/onboarding/pairing-success.tsx",
  "src/components/onboarding/trust-failure-state.tsx",
  "src/components/hosts/host-list-screen.tsx",
  "src/components/longtail/about-screen.tsx",
  "src/components/trust/device-approval-ceremony.tsx",
  "src/components/trust/device-approval-screen.tsx",
] as const;

describe("possess copy stays consistent", () => {
  it("never teaches spawnd login as the post-install pairing step", () => {
    const source = POST_INSTALL_SURFACES.map((path) =>
      readFileSync(resolve(process.cwd(), path), "utf8"),
    ).join("\n");

    expect(source).not.toContain("spawnd login");
    expect(source).toContain("After installation, run spawnd possess on that machine.");
  });
});

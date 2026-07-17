import { beforeAll, describe, expect, test } from "bun:test";
import {
  BUILDABLE_PRODUCTION_SOURCE_EXTENSIONS,
  browserSignerInventoryViolations,
  forbiddenProductionSourceViolations,
  hostControlInventoryViolations,
  isProductionSourcePath,
  loadProductionSourceFiles,
  type ProductionSourceFile,
  selectProductionSourceFiles,
} from "../../test-support/production-source-guard";

let productionSources: ProductionSourceFile[];

function inject(path: string, source: string): ProductionSourceFile[] {
  return selectProductionSourceFiles([...productionSources, { path, source }]);
}

function appendTo(path: string, source: string): ProductionSourceFile[] {
  return selectProductionSourceFiles(
    productionSources.map((file) =>
      file.path === path ? { ...file, source: `${file.source}\n${source}` } : file,
    ),
  );
}

function replaceIn(path: string, before: string, after: string): ProductionSourceFile[] {
  return selectProductionSourceFiles(
    productionSources.map((file) => {
      if (file.path !== path) return file;
      if (!file.source.includes(before)) throw new Error(`missing fixture source in ${path}`);
      return { ...file, source: file.source.replace(before, after) };
    }),
  );
}

beforeAll(async () => {
  productionSources = await loadProductionSourceFiles();
});

describe("bounded production source guard", () => {
  test("known-good production sources satisfy both exact inventories", () => {
    expect(browserSignerInventoryViolations(productionSources)).toEqual([]);
    expect(hostControlInventoryViolations(productionSources)).toEqual([]);
    expect(productionSources.map((file) => file.path)).toContain(
      "src/components/terminal/xterm-config.mjs",
    );
  });

  test("the exhaustive path selector includes every buildable extension and excludes tests", () => {
    expect(BUILDABLE_PRODUCTION_SOURCE_EXTENSIONS).toEqual([
      "js",
      "jsx",
      "mjs",
      "cjs",
      "ts",
      "tsx",
    ]);
    for (const extension of BUILDABLE_PRODUCTION_SOURCE_EXTENSIONS) {
      expect(isProductionSourcePath(`src/fixture.${extension}`)).toBe(true);
      expect(isProductionSourcePath(`src/fixture.test.${extension}`)).toBe(false);
      expect(isProductionSourcePath(`src/fixture.spec.${extension}`)).toBe(false);
      expect(isProductionSourcePath(`src/__tests__/fixture.${extension}`)).toBe(false);
    }
  });

  for (const extension of BUILDABLE_PRODUCTION_SOURCE_EXTENSIONS) {
    test(`.${extension} cannot hide test signers, a relay constructor, or raw HostControl aliases`, () => {
      const path = `src/guard-fixture.${extension}`;
      const sources = inject(
        path,
        `
          import { signRtcSignalWireForTestOnly, TestOnlySignedRtcIdentitySigner }
            from "../test-support/signed-signal-wire-test-only";
          import { HostControlClient as RawHostControl } from "./lib/hostControl";
          const signed_envelope = "{}";
          void SignedRtcIdentitySigner;
          const RawWireSigner = signRtcSignalWire;
          const CopiedHostControl = HostControlClient;
          new HostControlClient(hostId, rawTrust);
          new RawHostControl(hostId, rawTrust);
          new CopiedHostControl(hostId, rawTrust);
        `,
      );
      const forbidden = forbiddenProductionSourceViolations(sources);
      expect(forbidden).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`test-support import path in ${path}`),
          expect.stringContaining(`test-only RTC signer in ${path}`),
          expect.stringContaining(`test-only structural signer type in ${path}`),
          expect.stringContaining(`structural production signer type in ${path}`),
          expect.stringContaining(`live signed-envelope constructor in ${path}`),
        ]),
      );
      expect(browserSignerInventoryViolations(sources)).toEqual(
        expect.arrayContaining([expect.stringContaining("signRtcSignalWire references changed")]),
      );
      expect(hostControlInventoryViolations(sources)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("HostControlClient references changed"),
          expect.stringContaining("HostControlClient constructors changed"),
        ]),
      );
    });
  }

  for (const path of [
    "src/lib/browser-device-identity.ts",
    "src/lib/signed-signal.ts",
    "src/lib/signed-signal-wire.ts",
  ]) {
    test(`${path} is not exempt from universal signer and carrier prohibitions`, () => {
      const sources = appendTo(
        path,
        `
          void import("../../test-support/signed-signal-wire-test-only");
          void signRtcSignalWireForTestOnly;
          void TestOnlySignedRtcIdentitySigner;
          const signed_envelope = "{}";
        `,
      );
      expect(forbiddenProductionSourceViolations(sources)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`test-support import path in ${path}`),
          expect.stringContaining(`test-only RTC signer in ${path}`),
          expect.stringContaining(`test-only structural signer type in ${path}`),
          expect.stringContaining(`live signed-envelope constructor in ${path}`),
        ]),
      );
    });
  }

  test("the formerly exempt HostControl module rejects direct construction and copied aliases", () => {
    const path = "src/lib/hostControl.ts";
    const sources = appendTo(
      path,
      `
        const RawHostControlCopy = HostControlClient;
        new HostControlClient(hostId, rawTrust);
        new RawHostControlCopy(hostId, rawTrust);
      `,
    );
    expect(hostControlInventoryViolations(sources)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("HostControlClient references changed"),
        expect.stringContaining("HostControlClient constructors changed"),
      ]),
    );
  });

  test("the approved registry file cannot add a second constructor or rebind the class", () => {
    const path = "src/lib/host-control-trust.tsx";
    const sources = appendTo(
      path,
      `
        const RawHostControlCopy = HostControlClient;
        new HostControlClient(hostId, rawTrust);
        new RawHostControlCopy(hostId, rawTrust);
      `,
    );
    expect(hostControlInventoryViolations(sources)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("HostControlClient references changed"),
        expect.stringContaining("HostControlClient constructors changed"),
      ]),
    );
  });

  test("sensitive signer modules cannot add raw signing aliases inside approved files", () => {
    const sources = appendTo(
      "src/lib/browser-device-identity.ts",
      "const rawSignerCopy = signSignedSignalTranscript; void rawSignerCopy;",
    );
    expect(browserSignerInventoryViolations(sources)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("signSignedSignalTranscript references changed"),
      ]),
    );
  });

  test("an approved signer reference cannot change its reviewed call shape", () => {
    const sources = replaceIn(
      "src/lib/signed-signal-wire.ts",
      "    copyTranscript(transcript),\n  );",
      "    transcript,\n  );",
    );
    expect(browserSignerInventoryViolations(sources)).toEqual(
      expect.arrayContaining([expect.stringContaining("bounded wire signing call changed")]),
    );
  });

  test("the sole HostControl constructor cannot change its reviewed arguments", () => {
    const sources = replaceIn(
      "src/lib/host-control-trust.tsx",
      "return new HostControlClient(destination.hostId, material, options);",
      "return new HostControlClient(hostId, material, options);",
    );
    expect(hostControlInventoryViolations(sources)).toEqual(
      expect.arrayContaining([expect.stringContaining("trusted HostControl constructor changed")]),
    );
  });
});

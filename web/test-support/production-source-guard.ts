/**
 * TEST ONLY. Bounded grep-level inventories for security-sensitive production
 * source references. These checks deliberately do not parse JavaScript: exact
 * identifiers and reviewed call forms must remain easy to audit with rg.
 */

export const BUILDABLE_PRODUCTION_SOURCE_EXTENSIONS = [
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
] as const;

const MAX_PRODUCTION_SOURCE_FILES = 2_048;
const MAX_PRODUCTION_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PRODUCTION_SOURCE_TOTAL_BYTES = 32 * 1024 * 1024;

export interface ProductionSourceFile {
  readonly path: string;
  readonly source: string;
}

interface ExactReferenceRule {
  readonly symbol: string;
  readonly approved: ReadonlyArray<{ readonly path: string; readonly count: number }>;
}

interface ExactShapeRule {
  readonly label: string;
  readonly path: string;
  readonly pattern: RegExp;
  readonly count: number;
}

const FORBIDDEN_PRODUCTION_PATTERNS = [
  { label: "test-support import path", pattern: /\btest-support\b/gu },
  { label: "test-only RTC signer", pattern: /\bsignRtcSignalWireForTestOnly\b/gu },
  { label: "test-only structural signer type", pattern: /\bTestOnlySignedRtcIdentitySigner\b/gu },
  { label: "structural production signer type", pattern: /\bSignedRtcIdentitySigner\b/gu },
  { label: "live signed-envelope constructor", pattern: /\bsigned_envelope\b/gu },
] as const;

const BROWSER_SIGNER_REFERENCE_RULES: readonly ExactReferenceRule[] = [
  {
    symbol: "loadBrowserDeviceIdentity",
    approved: [
      { path: "src/lib/browser-device-identity.ts", count: 2 },
      { path: "src/lib/browser-trust-operations.ts", count: 2 },
    ],
  },
  {
    symbol: "scopeBrowserDeviceIdentityToTrustEpoch",
    approved: [
      { path: "src/lib/browser-device-identity.ts", count: 1 },
      { path: "src/lib/browser-trust-operations.ts", count: 2 },
    ],
  },
  {
    symbol: "createBrowserDeviceRegistrationProof",
    approved: [
      { path: "src/lib/browser-device-identity.ts", count: 1 },
      { path: "src/lib/browser-device-registration.ts", count: 2 },
    ],
  },
  {
    symbol: "createHostPairApprovalProof",
    approved: [
      { path: "src/lib/browser-device-identity.ts", count: 1 },
      { path: "src/lib/browser-trust-operations.ts", count: 2 },
    ],
  },
  {
    symbol: "signBrowserDeviceRtcTranscriptWithinTrustEpoch",
    approved: [
      { path: "src/lib/browser-device-identity.ts", count: 1 },
      { path: "src/lib/signed-signal-wire.ts", count: 2 },
    ],
  },
  {
    symbol: "signSignedSignalTranscript",
    approved: [
      { path: "src/lib/browser-device-identity.ts", count: 3 },
      { path: "src/lib/signed-signal.ts", count: 1 },
    ],
  },
  {
    symbol: "signRtcSignalWire",
    approved: [{ path: "src/lib/signed-signal-wire.ts", count: 1 }],
  },
  {
    symbol: "assertBrowserDeviceIdentitySignerActive",
    approved: [
      { path: "src/lib/browser-device-identity.ts", count: 5 },
      { path: "src/lib/signed-signal-wire.ts", count: 5 },
    ],
  },
];

const BROWSER_SIGNER_SHAPE_RULES: readonly ExactShapeRule[] = [
  {
    label: "registration proof call",
    path: "src/lib/browser-device-registration.ts",
    pattern: /\bcreateBrowserDeviceRegistrationProof\s*\(\s*identity\s*,\s*userId\s*\)/gu,
    count: 1,
  },
  {
    label: "approval dependency binding",
    path: "src/lib/browser-trust-operations.ts",
    pattern: /\bsignApproval\s*:\s*createHostPairApprovalProof\b/gu,
    count: 1,
  },
  {
    label: "epoch scope dependency binding",
    path: "src/lib/browser-trust-operations.ts",
    pattern: /\bscopeIdentity\s*:\s*scopeBrowserDeviceIdentityToTrustEpoch\b/gu,
    count: 1,
  },
  {
    label: "stored-record self-check signing call",
    path: "src/lib/browser-device-identity.ts",
    pattern: /\bsignSignedSignalTranscript\s*\(\s*record\.privateKey\s*,\s*transcript\s*\)/gu,
    count: 1,
  },
  {
    label: "epoch RTC signing call",
    path: "src/lib/browser-device-identity.ts",
    pattern:
      /\bsignSignedSignalTranscript\s*\(\s*capability\.record\.privateKey\s*,\s*transcript\s*\)/gu,
    count: 1,
  },
  {
    label: "bounded wire signing call",
    path: "src/lib/signed-signal-wire.ts",
    pattern:
      /\bsignBrowserDeviceRtcTranscriptWithinTrustEpoch\s*\(\s*signer\s*,\s*copyTranscript\(transcript\)\s*,?\s*\)/gu,
    count: 1,
  },
  {
    label: "nominal production wire signer definition",
    path: "src/lib/signed-signal-wire.ts",
    pattern:
      /export\s+async\s+function\s+signRtcSignalWire\s*\(\s*signer\s*:\s*EpochScopedBrowserDeviceIdentity\b/gu,
    count: 1,
  },
];

const HOST_CONTROL_REFERENCE_RULES: readonly ExactReferenceRule[] = [
  {
    symbol: "HostControlClient",
    approved: [
      { path: "src/hooks/useHostControl.ts", count: 3 },
      { path: "src/lib/host-control-trust.tsx", count: 7 },
      { path: "src/lib/hostControl.ts", count: 4 },
    ],
  },
];

const HOST_CONTROL_SHAPE_RULES: readonly ExactShapeRule[] = [
  {
    label: "HostControl class definition",
    path: "src/lib/hostControl.ts",
    pattern: /export\s+class\s+HostControlClient\b/gu,
    count: 1,
  },
  {
    label: "trusted HostControl constructor",
    path: "src/lib/host-control-trust.tsx",
    pattern:
      /return\s+new\s+HostControlClient\s*\(\s*destination\.hostId\s*,\s*material\s*,\s*options\s*\)\s*;/gu,
    count: 1,
  },
];

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function isProductionSourcePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized.startsWith("src/") || normalized.includes("/__tests__/")) return false;
  const extension = normalized.slice(normalized.lastIndexOf(".") + 1);
  if (!(BUILDABLE_PRODUCTION_SOURCE_EXTENSIONS as readonly string[]).includes(extension)) {
    return false;
  }
  return !new RegExp(`\\.(?:test|spec)\\.${extension}$`, "u").test(normalized);
}

export function selectProductionSourceFiles(
  candidates: readonly ProductionSourceFile[],
): ProductionSourceFile[] {
  const selected = candidates
    .map((file) => ({ path: normalizePath(file.path), source: file.source }))
    .filter((file) => isProductionSourcePath(file.path))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (selected.length > MAX_PRODUCTION_SOURCE_FILES) {
    throw new Error("production source inventory exceeds its file bound");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of selected) {
    if (seen.has(file.path)) throw new Error(`duplicate production source path: ${file.path}`);
    seen.add(file.path);
    const bytes = new TextEncoder().encode(file.source).byteLength;
    if (bytes > MAX_PRODUCTION_SOURCE_FILE_BYTES) {
      throw new Error(`production source file exceeds its byte bound: ${file.path}`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_PRODUCTION_SOURCE_TOTAL_BYTES) {
      throw new Error("production source inventory exceeds its total byte bound");
    }
  }
  return selected;
}

export async function loadProductionSourceFiles(root = "."): Promise<ProductionSourceFile[]> {
  const candidates: ProductionSourceFile[] = [];
  for (const extension of BUILDABLE_PRODUCTION_SOURCE_EXTENSIONS) {
    const glob = new Bun.Glob(`src/**/*.${extension}`);
    for await (const path of glob.scan(root)) {
      const file = Bun.file(`${root}/${path}`);
      if (file.size > MAX_PRODUCTION_SOURCE_FILE_BYTES) {
        throw new Error(`production source file exceeds its byte bound: ${path}`);
      }
      candidates.push({ path, source: await file.text() });
    }
  }
  return selectProductionSourceFiles(candidates);
}

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function exactReferenceViolations(
  files: readonly ProductionSourceFile[],
  rules: readonly ExactReferenceRule[],
): string[] {
  const violations: string[] = [];
  for (const rule of rules) {
    const pattern = new RegExp(`\\b${rule.symbol}\\b`, "gu");
    const actual = files
      .map((file) => ({ path: file.path, count: countMatches(file.source, pattern) }))
      .filter((hit) => hit.count > 0);
    if (JSON.stringify(actual) !== JSON.stringify(rule.approved)) {
      violations.push(
        `${rule.symbol} references changed: expected ${JSON.stringify(rule.approved)}, got ${JSON.stringify(actual)}`,
      );
    }
  }
  return violations;
}

function exactShapeViolations(
  files: readonly ProductionSourceFile[],
  rules: readonly ExactShapeRule[],
): string[] {
  const byPath = new Map(files.map((file) => [file.path, file.source]));
  const violations: string[] = [];
  for (const rule of rules) {
    const count = countMatches(byPath.get(rule.path) ?? "", rule.pattern);
    if (count !== rule.count) {
      violations.push(
        `${rule.label} changed in ${rule.path}: expected ${rule.count}, got ${count}`,
      );
    }
  }
  return violations;
}

export function forbiddenProductionSourceViolations(
  files: readonly ProductionSourceFile[],
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (const forbidden of FORBIDDEN_PRODUCTION_PATTERNS) {
      const count = countMatches(file.source, forbidden.pattern);
      if (count > 0) violations.push(`${forbidden.label} in ${file.path} (${count})`);
    }
  }
  return violations;
}

export function browserSignerInventoryViolations(files: readonly ProductionSourceFile[]): string[] {
  return [
    ...forbiddenProductionSourceViolations(files),
    ...exactReferenceViolations(files, BROWSER_SIGNER_REFERENCE_RULES),
    ...exactShapeViolations(files, BROWSER_SIGNER_SHAPE_RULES),
  ];
}

export function hostControlInventoryViolations(files: readonly ProductionSourceFile[]): string[] {
  const constructorPattern = /\bnew\s+HostControlClient\s*\(/gu;
  const constructorHits = files
    .map((file) => ({ path: file.path, count: countMatches(file.source, constructorPattern) }))
    .filter((hit) => hit.count > 0);
  const violations = [
    ...forbiddenProductionSourceViolations(files),
    ...exactReferenceViolations(files, HOST_CONTROL_REFERENCE_RULES),
  ];
  const approvedConstructor = [{ path: "src/lib/host-control-trust.tsx", count: 1 }];
  if (JSON.stringify(constructorHits) !== JSON.stringify(approvedConstructor)) {
    violations.push(
      `HostControlClient constructors changed: expected ${JSON.stringify(approvedConstructor)}, got ${JSON.stringify(constructorHits)}`,
    );
  }
  return [...violations, ...exactShapeViolations(files, HOST_CONTROL_SHAPE_RULES)];
}

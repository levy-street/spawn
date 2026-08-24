import { chainReachableFrom, edgesToward } from "@/data/trust/chain-reach";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D = "00000000-0000-4000-8000-00000000000d";
const REVOKED = "00000000-0000-4000-8000-0000000000ee";

const devices = [
  { id: A, revoked_at: null },
  { id: B, revoked_at: null },
  { id: C, revoked_at: null },
  { id: D, revoked_at: null },
  { id: REVOKED, revoked_at: "2026-08-24T00:00:00Z" },
];

function edge(endorser: string, endorsed: string) {
  return {
    endorser_device_id: endorser,
    endorsed_device_id: endorsed,
    tag: `${endorser}>${endorsed}`,
  };
}

describe("chainReachableFrom", () => {
  test("walks anchor→…→device over live edges only", () => {
    const edges = [edge(A, B), edge(B, C), edge(REVOKED, D)];
    const reachable = chainReachableFrom([A], devices, edges);
    expect(reachable.has(B)).toBe(true);
    expect(reachable.has(C)).toBe(true);
    // An edge from a revoked device grants nothing.
    expect(reachable.has(D)).toBe(false);
  });

  test("an edge INTO a revoked device is dead too, and the chain stops there", () => {
    const edges = [edge(A, REVOKED), edge(REVOKED, C)];
    const reachable = chainReachableFrom([A], devices, edges);
    expect(reachable.has(REVOKED)).toBe(false);
    expect(reachable.has(C)).toBe(false);
  });

  test("direction matters: an endorsement does not flow backwards", () => {
    expect(chainReachableFrom([B], devices, [edge(A, B)]).has(A)).toBe(false);
  });

  test("respects the chain length cap", () => {
    const edges = [edge(A, B), edge(B, C), edge(C, D)];
    expect(chainReachableFrom([A], devices, edges, 2).has(D)).toBe(false);
    expect(chainReachableFrom([A], devices, edges, 3).has(D)).toBe(true);
  });
});

describe("edgesToward", () => {
  test("keeps only the edges upstream of the device", () => {
    const toward = edge(A, B);
    const further = edge(D, A);
    // Downstream of B: it can sit on no chain that ends at B.
    const unrelated = edge(B, C);
    const kept = edgesToward(B, devices, [unrelated, toward, further]);
    expect(kept.map((e) => e.tag).sort()).toEqual([further.tag, toward.tag].sort());
  });

  test("drops edges through a revoked device", () => {
    const kept = edgesToward(B, devices, [edge(REVOKED, B), edge(A, REVOKED)]);
    expect(kept).toEqual([]);
  });

  test("tolerates cycles without looping", () => {
    const kept = edgesToward(B, devices, [edge(A, B), edge(B, A)]);
    expect(kept).toHaveLength(2);
  });
});

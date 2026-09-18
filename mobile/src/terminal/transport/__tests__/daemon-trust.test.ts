import { verifyDaemonHost } from "@/terminal/transport/daemon-trust";

let mockAccount: string | null = "account-a";
const mockResolve = jest.fn();
jest.mock("@/data/api/config", () => ({ getBaseUrl: async () => "https://example.test" }));
jest.mock("@/data/trust/host-pins", () => ({
  openHostPinStore: async () => ({ resolve: mockResolve }),
}));
jest.mock("@/lib/crypto/identity", () => ({ activeDeviceIdentityAccount: () => mockAccount }));
beforeEach(() => {
  mockAccount = "account-a";
  mockResolve.mockReset();
});
test.each(["match", "missing"])("permits signed %s host identity", async (status) => {
  mockResolve.mockResolvedValue({ status });
  await expect(verifyDaemonHost("host", "public-key")).resolves.toBeUndefined();
  expect(mockResolve).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "account-a",
      serverOrigin: "https://example.test",
      hostId: "host",
      presentedHostPublicKey: "public-key",
    }),
  );
});
test.each(["revoked", "mismatch", "storage-unavailable", "identity-missing"])(
  "refuses %s without falling back",
  async (status) => {
    mockResolve.mockResolvedValue({ status });
    await expect(verifyDaemonHost("host", "public-key")).rejects.toMatchObject({
      code: "host_identity_unverified",
    });
  },
);
test("an account change during pin lookup fences the result", async () => {
  mockResolve.mockImplementation(async () => {
    mockAccount = "account-b";
    return { status: "match" };
  });
  await expect(verifyDaemonHost("host", "public-key")).rejects.toMatchObject({
    code: "signed_out",
  });
});

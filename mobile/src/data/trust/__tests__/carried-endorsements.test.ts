import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import type { AccountEndorsementRecord } from "@/data/api/schemas/trust";
import {
  type CarriedEndorsementApi,
  loadCarriedEndorsements,
  loadMemoizedCarriedEndorsements,
} from "@/data/trust/carried-endorsements";
import { invalidateDeviceHostTrust } from "@/data/trust/device-trust";
import { encodeBase64Url } from "@/lib/crypto/bytes";

const mockListBrowserDevices = jest.fn(async () => []);

jest.mock("@/data/api/endpoints/devices", () => ({
  listBrowserDevices: () => mockListBrowserDevices(),
}));

jest.mock("@/data/api/endpoints/trust", () => ({
  listAccountEndorsements: jest.fn(async () => []),
  listHostPins: jest.fn(async () => []),
}));

jest.mock("@/lib/crypto/identity", () => ({
  activeDeviceIdentityAccount: () => "00000000-0000-4000-8000-000000000001",
  deviceIdentity: { publicKey: async () => new Uint8Array(32) },
}));

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";
const THIS_DEVICE_ID = "00000000-0000-4000-8000-000000000002";
const W_ID = "00000000-0000-4000-8000-000000000003";
const X_ID = "00000000-0000-4000-8000-000000000004";
const A_ID = "00000000-0000-4000-8000-000000000005";
const B_ID = "00000000-0000-4000-8000-000000000006";
const THIS_PUBLIC_KEY = encodeBase64Url(new Uint8Array(32));

function device(id: string, publicKey: string): BrowserDeviceOut {
  return {
    id,
    key_algorithm: "ed25519",
    public_key: publicKey,
    label: null,
    created_at: "2026-08-25T00:00:00Z",
    revoked_at: null,
  };
}

function edge(
  endorserDeviceId: string,
  endorserPublicKey: string,
  endorsedDeviceId: string,
  endorsedPublicKey: string,
): AccountEndorsementRecord {
  return {
    endorser_device_id: endorserDeviceId,
    endorser_public_key: endorserPublicKey,
    endorsed_device_id: endorsedDeviceId,
    endorsed_public_key: endorsedPublicKey,
    signature: `${endorserDeviceId}>${endorsedDeviceId}`,
    created_at: "2026-08-25T00:00:00Z",
  };
}

function api(overrides: Partial<CarriedEndorsementApi> = {}): CarriedEndorsementApi {
  return {
    accountId: () => ACCOUNT_ID,
    publicKey: async () => new Uint8Array(32),
    listBrowserDevices: async () => [device(THIS_DEVICE_ID, THIS_PUBLIC_KEY)],
    listAccountEndorsements: async () => [],
    ...overrides,
  };
}

describe("loadCarriedEndorsements", () => {
  test("returns no edges without an account, identity key, or matching live device", async () => {
    await expect(loadCarriedEndorsements(api({ accountId: () => null }))).resolves.toEqual([]);
    await expect(loadCarriedEndorsements(api({ publicKey: async () => null }))).resolves.toEqual(
      [],
    );
    await expect(
      loadCarriedEndorsements(
        api({ listBrowserDevices: async () => [device(A_ID, "unrelated-key")] }),
      ),
    ).resolves.toEqual([]);
  });

  test("maps account endorsement edges to their exact carried wire shape", async () => {
    const endorsement = edge(W_ID, "w-key", THIS_DEVICE_ID, THIS_PUBLIC_KEY);

    await expect(
      loadCarriedEndorsements(
        api({
          listBrowserDevices: async () => [
            device(W_ID, "w-key"),
            device(THIS_DEVICE_ID, THIS_PUBLIC_KEY),
          ],
          listAccountEndorsements: async () => [endorsement],
        }),
      ),
    ).resolves.toEqual([
      {
        account_id: ACCOUNT_ID,
        endorser_public_key: "w-key",
        endorsed_public_key: THIS_PUBLIC_KEY,
        endorsed_device_id: THIS_DEVICE_ID,
        signature: endorsement.signature,
      },
    ]);
  });

  test("prunes edges that are not upstream of this device", async () => {
    const unrelated = edge(A_ID, "a-key", B_ID, "b-key");
    const towardThisDevice = edge(X_ID, "x-key", THIS_DEVICE_ID, THIS_PUBLIC_KEY);
    const upstream = edge(W_ID, "w-key", X_ID, "x-key");

    const carried = await loadCarriedEndorsements(
      api({
        listBrowserDevices: async () => [
          device(THIS_DEVICE_ID, THIS_PUBLIC_KEY),
          device(W_ID, "w-key"),
          device(X_ID, "x-key"),
          device(A_ID, "a-key"),
          device(B_ID, "b-key"),
        ],
        listAccountEndorsements: async () => [unrelated, towardThisDevice, upstream],
      }),
    );

    expect(carried.map((item) => item.signature)).toEqual([
      towardThisDevice.signature,
      upstream.signature,
    ]);
  });
});

describe("loadMemoizedCarriedEndorsements", () => {
  beforeEach(() => {
    mockListBrowserDevices.mockClear();
    invalidateDeviceHostTrust();
  });

  test("shares one read across a burst of reconnects", async () => {
    await loadMemoizedCarriedEndorsements();
    await loadMemoizedCarriedEndorsements();
    expect(mockListBrowserDevices).toHaveBeenCalledTimes(1);
  });

  test("reads again once an approval may have landed", async () => {
    await loadMemoizedCarriedEndorsements();
    // The verdict and the edges are one view of this device's admission, and
    // refreshing the verdict against edges cached from before the approval is
    // what left a phone told it was trusted while it re-offered refused proof.
    invalidateDeviceHostTrust();
    await loadMemoizedCarriedEndorsements();
    expect(mockListBrowserDevices).toHaveBeenCalledTimes(2);
  });
});

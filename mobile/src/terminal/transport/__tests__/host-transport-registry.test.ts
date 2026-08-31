import { retainHostTransport } from "@/terminal/transport/host-transport-registry";

const mockClose = jest.fn();
const mockCreateHostTransport = jest.fn((_options: unknown) => ({ close: mockClose }));

jest.mock("@/terminal/transport/host-transport", () => ({
  createHostTransport: (options: unknown) => mockCreateHostTransport(options),
}));

describe("host transport registry", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("shares one transport per host and hands worker ownership to the next consumer", () => {
    const options = {
      hostId: "00112233-4455-6677-8899-aabbccddeeff",
      hostIdentityPublicKey: "host-key",
    };
    const first = retainHostTransport(options);
    const second = retainHostTransport(options);
    const secondOwnership = jest.fn();
    second.subscribeOwnership(secondOwnership);

    expect(first.shared).toBe(second.shared);
    expect(mockCreateHostTransport).toHaveBeenCalledTimes(1);
    expect(secondOwnership).toHaveBeenLastCalledWith(false);

    first.release();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(secondOwnership).toHaveBeenLastCalledWith(true);

    second.release();
    expect(mockClose).toHaveBeenCalledTimes(2);
  });

  test("a consumer swapped in the same commit still claims the vacant seat", () => {
    const options = {
      hostId: "00112233-4455-6677-8899-aabbccddef01",
      hostIdentityPublicKey: "host-key",
    };
    // React mounts the replacement before unmounting the outgoing one, so the
    // newcomer holds a lease but has not subscribed yet when the owner leaves.
    const outgoing = retainHostTransport(options);
    const incoming = retainHostTransport(options);
    outgoing.release();

    // The seat is vacant: nobody was listening to inherit it.
    const ownership = jest.fn();
    incoming.subscribeOwnership(ownership);
    expect(ownership).toHaveBeenLastCalledWith(true);
    expect(incoming.shared.owner).toBe(incoming.ownerId);

    // And it is not handed out twice.
    const third = retainHostTransport(options);
    const thirdOwnership = jest.fn();
    third.subscribeOwnership(thirdOwnership);
    expect(thirdOwnership).toHaveBeenLastCalledWith(false);

    third.release();
    incoming.release();
  });
});

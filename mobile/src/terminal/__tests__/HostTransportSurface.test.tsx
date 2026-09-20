import { act, render } from "@testing-library/react-native";
import { deviceIdentity, setDeviceIdentityAccount } from "@/lib/crypto/identity";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";

const mockRelease = jest.fn();
const mockTransport = {
  state: "ready",
  on: jest.fn(() => () => undefined),
  prepare: jest.fn(),
  open: jest.fn(async () => {}),
  close: jest.fn(),
};
const mockConsumer = {
  ...mockTransport,
  open: jest.fn(async () => {}),
  close: jest.fn(),
};
jest.mock("@/terminal/transport/host-transport", () => ({
  createHostConsumerTransport: () => mockConsumer,
}));
const mockLease = {
  ownerId: Symbol("consumer"),
  shared: { owner: Symbol("root"), transport: mockTransport, bridge: {} },
  subscribeOwnership: (listener: (owns: boolean) => void) => {
    listener(false);
    return () => undefined;
  },
  release: mockRelease,
};
jest.mock("@/terminal/transport/host-transport-registry", () => ({
  retainHostTransport: () => mockLease,
}));
jest.mock("react-native-webview", () => ({ __esModule: true, default: () => null }));

beforeEach(() => jest.clearAllMocks());

test("a consumer joining a ready app-owned connection immediately receives readiness", async () => {
  const onStateChange = jest.fn();
  const onTransport = jest.fn();
  const result = await render(
    <HostTransportSurface
      hostId="host"
      hostIdentityPublicKey="key"
      onTransport={onTransport}
      onStateChange={onStateChange}
    />,
  );
  expect(onTransport).toHaveBeenCalledWith(mockConsumer);
  expect(onStateChange).toHaveBeenLastCalledWith("ready");
  expect(mockConsumer.open).toHaveBeenCalledTimes(1);
  expect(mockTransport.open).not.toHaveBeenCalled();
  await result.unmount();
  expect(mockConsumer.close).toHaveBeenCalledTimes(1);
  expect(mockTransport.close).not.toHaveBeenCalled();
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test("the app connection owner exposes the root without creating or closing a tool", async () => {
  const onTransport = jest.fn();
  const result = await render(
    <HostTransportSurface
      connectionOwner
      hostId="host"
      hostIdentityPublicKey="key"
      onTransport={onTransport}
    />,
  );
  expect(onTransport).toHaveBeenCalledWith(mockTransport);
  expect(mockConsumer.open).not.toHaveBeenCalled();
  await result.unmount();
  expect(mockConsumer.close).not.toHaveBeenCalled();
  expect(mockTransport.close).not.toHaveBeenCalled();
  expect(mockRelease).toHaveBeenCalledTimes(1);
});

test("replacing the device key recreates a mounted host surface within the same account", async () => {
  mockRelease.mockClear();
  const accountId = "00000000-0000-4000-8000-000000000001";
  setDeviceIdentityAccount(accountId);
  const onTransport = jest.fn();
  const result = await render(
    <HostTransportSurface hostId="host" hostIdentityPublicKey="key" onTransport={onTransport} />,
  );
  expect(onTransport).toHaveBeenCalledTimes(1);
  await act(async () => {
    await deviceIdentity.reset();
  });
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(onTransport).toHaveBeenCalledTimes(2);
  // Registration may rebind after React has already rendered the cleared
  // account. That later binding must also create a fresh worker.
  await act(() => setDeviceIdentityAccount(accountId));
  expect(mockRelease).toHaveBeenCalledTimes(2);
  expect(onTransport).toHaveBeenCalledTimes(3);
  await result.unmount();
});

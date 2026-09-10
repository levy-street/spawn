import { act, render } from "@testing-library/react-native";
import { deviceIdentity, setDeviceIdentityAccount } from "@/lib/crypto/identity";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";

const mockRelease = jest.fn();
const mockTransport = { state: "ready", on: jest.fn(() => () => undefined), prepare: jest.fn() };
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
  expect(onTransport).toHaveBeenCalledWith(mockTransport);
  expect(onStateChange).toHaveBeenLastCalledWith("ready");
  await result.unmount();
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

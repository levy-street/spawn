import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

import { useDeviceApprovalGate } from "@/components/trust/device-approval-gate";
import type { DeviceHostTrust } from "@/data/trust/device-trust";

const HOST_ID = "00000000-0000-4000-8000-0000000000aa";

let mockTrust: DeviceHostTrust = "untrusted";
jest.mock("@/data/trust/device-trust", () => ({
  DEVICE_NOT_TRUSTED_CODE: "device_not_trusted",
  invalidateDeviceHostTrust: jest.fn(),
  probeDeviceHostTrust: jest.fn(async () => mockTrust),
}));

let mockWatch: DeviceHostTrust = "unknown";
jest.mock("@/data/trust/use-host-approval-watch", () => ({
  APPROVAL_WATCH_INTERVAL_MS: 3_000,
  useHostApprovalWatch: () => mockWatch,
}));

jest.mock("@/components/trust/device-approval-overlay", () => ({
  ...(() => {
    const { Pressable: MockPressable, Text: MockText } =
      require("react-native") as typeof import("react-native");
    return {
      DeviceApprovalOverlay: ({
        visible,
        onDismiss,
      }: {
        visible: boolean;
        onDismiss: () => void;
      }) =>
        visible ? (
          <MockPressable onPress={onDismiss} testID="approval-sheet">
            <MockText>Approve this device</MockText>
          </MockPressable>
        ) : null,
    };
  })(),
}));

const action = jest.fn();

function Harness() {
  const gate = useDeviceApprovalGate();
  return (
    <>
      <Pressable onPress={() => gate.guard(HOST_ID, action)} testID="do-the-thing">
        <Text>Do the thing</Text>
      </Pressable>
      {gate.overlay}
    </>
  );
}

describe("the device approval gate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTrust = "untrusted";
    mockWatch = "unknown";
  });

  test("a trusted machine is not made to ask", async () => {
    mockTrust = "trusted";
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId("do-the-thing"));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("approval-sheet")).toBeNull();
  });

  test("a probe that could not answer never holds the action hostage", async () => {
    // "unknown" is a question nobody could answer, not a refusal.
    mockTrust = "unknown";
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId("do-the-thing"));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("approval-sheet")).toBeNull();
  });

  test("an untrusted machine asks first, then carries on by itself", async () => {
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId("do-the-thing"));
    await waitFor(() => expect(screen.getByTestId("approval-sheet")).toBeOnTheScreen());
    expect(action).not.toHaveBeenCalled();

    // The approval lands, and the sheet holds its "approved" for a beat before
    // closing itself; the action goes with the close, not the news.
    mockWatch = "trusted";
    await screen.rerender(<Harness />);
    expect(action).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("approval-sheet"));
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("a ceremony closed without an approval drops the action", async () => {
    await render(<Harness />);
    await fireEvent.press(screen.getByTestId("do-the-thing"));
    await waitFor(() => expect(screen.getByTestId("approval-sheet")).toBeOnTheScreen());
    await fireEvent.press(screen.getByTestId("approval-sheet"));
    expect(action).not.toHaveBeenCalled();
  });
});

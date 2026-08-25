import { act, fireEvent, render, screen } from "@testing-library/react-native";

import { CameraHost, captureWithCamera } from "@/components/media/camera-host";

jest.mock("@/components/media/camera-overlay", () => {
  const React = require("react") as typeof import("react");
  const { Pressable, Text } = require("react-native") as typeof import("react-native");
  return {
    CameraOverlay: ({
      visible,
      onCapture,
      onClose,
    }: {
      visible: boolean;
      onCapture: (picture: { uri: string; name: string; mimeType: string | null }) => void;
      onClose: () => void;
    }) => {
      if (!visible) return null;
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          Pressable,
          {
            onPress: () =>
              onCapture({ uri: "file:///photo.jpg", name: "photo.jpg", mimeType: null }),
            testID: "stub-capture",
          },
          React.createElement(Text, null, "capture"),
        ),
        React.createElement(
          Pressable,
          { onPress: onClose, testID: "stub-close" },
          React.createElement(Text, null, "close"),
        ),
      );
    },
  };
});

describe("CameraHost", () => {
  it("shows the camera on request and resolves with the photo taken", async () => {
    await render(<CameraHost />);
    expect(screen.queryByTestId("stub-capture")).toBeNull();

    let picture: Promise<unknown> = Promise.resolve();
    await act(async () => {
      picture = captureWithCamera();
    });
    expect(screen.getByTestId("stub-capture")).toBeOnTheScreen();

    await fireEvent.press(screen.getByTestId("stub-capture"));
    await expect(picture).resolves.toEqual({
      uri: "file:///photo.jpg",
      name: "photo.jpg",
      mimeType: null,
    });
    expect(screen.queryByTestId("stub-capture")).toBeNull();
  });

  it("resolves with nothing when the camera is closed instead", async () => {
    await render(<CameraHost />);
    let picture: Promise<unknown> = Promise.resolve();
    await act(async () => {
      picture = captureWithCamera();
    });
    await fireEvent.press(screen.getByTestId("stub-close"));
    await expect(picture).resolves.toBeNull();
  });
});

import { act, render } from "@testing-library/react-native";

import WorkspaceDetailRoute from "@/app/workspace/[id]";
import type { WorkspaceDetailProps } from "@/components/workspace-detail/workspace-detail";

const mockPush = jest.fn();
const mockBack = jest.fn();
let mockDetailProps: WorkspaceDetailProps | null = null;

jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: "workspace-1" }),
  useRouter: () => ({ push: mockPush, back: mockBack }),
}));

jest.mock("@/components/workspace-detail/workspace-detail", () => ({
  WorkspaceDetail: (props: WorkspaceDetailProps) => {
    mockDetailProps = props;
    return null;
  },
}));

describe("WorkspaceDetailRoute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDetailProps = null;
  });

  it("routes terminal and files rows to their native surfaces", async () => {
    await render(<WorkspaceDetailRoute />);
    expect(mockDetailProps?.workspaceId).toBe("workspace-1");

    await act(() => mockDetailProps?.onOpenTerminal("session-1"));
    expect(mockPush).toHaveBeenCalledWith("/terminal/session-1");

    await act(() => mockDetailProps?.onOpenFiles("host-1", "/Users/spawn/my work"));
    expect(mockPush).toHaveBeenCalledWith("/host/host-1/files?path=%2FUsers%2Fspawn%2Fmy%20work");

    await act(() => mockDetailProps?.onBack());
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});

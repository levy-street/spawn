import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren } from "react";
import { AppearancePanel } from "@/components/settings/appearance-panel";
import { saveAgentYoloPreference } from "@/data/queries/settings";
import { THEME_STORAGE_KEY, ThemeProvider } from "@/theme";

const mockPatchAgentPreferences = jest.fn();

jest.mock("@/data/api/endpoints/agents", () => ({
  listAgents: jest.fn(async () => []),
  createAgent: jest.fn(),
  patchAgent: jest.fn(),
  deleteAgent: jest.fn(),
  patchAgentPreferences: (...args: unknown[]) => mockPatchAgentPreferences(...args),
}));

function themeWrapper({ children }: PropsWithChildren): React.JSX.Element {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("settings persistence scope", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  });

  test("theme mode changes through ThemeProvider and persists per device", async () => {
    const screen = await render(<AppearancePanel />, { wrapper: themeWrapper });
    await fireEvent.press(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
    });
  });

  test("agent yolo preferences persist through the account API, not AsyncStorage", async () => {
    mockPatchAgentPreferences.mockResolvedValue({ id: "agent-id", yolo: true });
    await saveAgentYoloPreference("agent-id", true);

    expect(mockPatchAgentPreferences).toHaveBeenCalledWith("agent-id", { yolo: true });
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });
});

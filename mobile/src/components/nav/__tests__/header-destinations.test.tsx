import { fireEvent, render } from "@testing-library/react-native";

import { HeaderDestinations } from "@/components/nav/header-destinations";
import { ThemeProvider } from "@/theme";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

describe("HeaderDestinations", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("navigates directly without opening a menu", async () => {
    const screen = await render(
      <ThemeProvider>
        <HeaderDestinations destinations={["hosts", "settings"]} />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByLabelText("Open hosts"));
    await fireEvent.press(screen.getByLabelText("Open settings"));

    expect(mockPush).toHaveBeenNthCalledWith(1, "/hosts");
    expect(mockPush).toHaveBeenNthCalledWith(2, "/settings");
    expect(screen.queryByLabelText(/menu/i)).toBeNull();
  });
});

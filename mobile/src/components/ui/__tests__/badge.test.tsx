import { render, screen } from "@testing-library/react-native";

import { Badge } from "@/components/ui/badge";
import { ThemeProvider } from "@/theme";

describe("Badge", () => {
  it("prints children that arrive as several strings and numbers as one label", async () => {
    // `🔥 {n} day streak` is three children to React, and a badge that only
    // recognised a lone string drew an empty pill around them.
    await render(
      <ThemeProvider>
        <Badge variant="warning">🔥 {2} day streak</Badge>
      </ThemeProvider>,
    );
    expect(screen.getByText("🔥 2 day streak")).toBeOnTheScreen();
  });
});

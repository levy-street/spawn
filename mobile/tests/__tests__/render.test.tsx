import { useQueryClient } from "@tanstack/react-query";
import { Text } from "react-native";

import { useTheme } from "@/theme";

import { createTestQueryClient, renderWithProviders } from "../render";

function ProviderProbe() {
  const theme = useTheme();
  const queryClient = useQueryClient();
  const value = queryClient.getQueryData<string>(["probe"]);
  return <Text>{`${value}:${theme.radii.md}`}</Text>;
}

describe("renderWithProviders", () => {
  it("supplies an isolated QueryClient and the spawn theme", async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["probe"], "ready");

    const screen = await renderWithProviders(<ProviderProbe />, { queryClient });

    expect(screen.getByText("ready:8")).toBeOnTheScreen();
    expect(screen.queryClient).toBe(queryClient);
  });
});

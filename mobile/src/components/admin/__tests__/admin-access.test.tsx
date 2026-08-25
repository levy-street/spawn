import { fireEvent, render } from "@testing-library/react-native";

import { AdminAccessBoundary, resolveAdminAccess } from "@/components/admin/admin-access";
import { Text } from "@/components/ui/text";
import { ThemeProvider } from "@/theme";

describe("admin authorization", () => {
  test("resolves only an explicit administrator to allowed", () => {
    expect(resolveAdminAccess({ error: null, loading: true, user: undefined })).toBe("loading");
    expect(
      resolveAdminAccess({ error: new Error("offline"), loading: false, user: undefined }),
    ).toBe("error");
    expect(resolveAdminAccess({ error: null, loading: false, user: { is_admin: false } })).toBe(
      "denied",
    );
    expect(resolveAdminAccess({ error: null, loading: false, user: { is_admin: true } })).toBe(
      "allowed",
    );
  });

  test("does not mount protected content for a non-admin", async () => {
    const onBack = jest.fn();
    const screen = await render(
      <ThemeProvider>
        <AdminAccessBoundary onBack={onBack} onRetry={jest.fn()} state="denied">
          <Text>Secret admin content</Text>
        </AdminAccessBoundary>
      </ThemeProvider>,
    );

    expect(screen.getByText("Nothing here")).toBeOnTheScreen();
    expect(screen.getByText("This account does not administer this deployment.")).toBeOnTheScreen();
    expect(screen.queryByText("Secret admin content")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Back to SPAWN D" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

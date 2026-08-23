import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren, ReactElement } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LoginScreen } from "@/components/auth/login-form";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import {
  ResetPasswordScreen,
  validateResetPasswordForm,
} from "@/components/auth/reset-password-form";
import { validateSignupForm } from "@/components/auth/signup-form";
import { ApiError } from "@/data/api/client";
import { confirmPasswordReset, getAuthConfig, logIn } from "@/data/api/endpoints/auth";
import { fontFamily, ThemeProvider } from "@/theme";

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => true);

jest.mock("expo-router", () => ({
  useRouter: () => ({
    back: mockBack,
    canGoBack: mockCanGoBack,
    push: mockPush,
    replace: mockReplace,
  }),
}));

jest.mock("@/data/api/endpoints/account", () => ({ getMe: jest.fn() }));
jest.mock("@/data/api/endpoints/hosts", () => ({ listHosts: jest.fn() }));
jest.mock("@/data/api/endpoints/auth", () => ({
  confirmEmailVerification: jest.fn(),
  confirmPasswordReset: jest.fn(),
  getAuthConfig: jest.fn(),
  logIn: jest.fn(),
  requestEmailVerification: jest.fn(),
  requestPasswordReset: jest.fn(),
  signUp: jest.fn(),
}));

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

function TestProviders({ children }: PropsWithChildren) {
  const queryClient = new QueryClient({
    defaultOptions: {
      mutations: { gcTime: Number.POSITIVE_INFINITY, retry: false },
      queries: { gcTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

async function renderAuth(ui: ReactElement) {
  return render(ui, { wrapper: TestProviders });
}

describe("auth form wiring", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getAuthConfig).mockResolvedValue({
      providers: [{ id: "google", name: "Google" }],
      email_verification_required: false,
      invite_only: false,
    });
  });

  it("blocks invalid login input and shows the shared exact validation copy", async () => {
    const screen = await renderAuth(<LoginScreen />);
    await screen.findByText("Available in installed builds");
    await fireEvent.changeText(screen.getByTestId("login-email"), "not-an-email");
    await fireEvent.changeText(screen.getByTestId("login-password"), "secret");
    await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(logIn).not.toHaveBeenCalled();
  });

  it("prints the sign-in form on the sheet, using the app's own fields", async () => {
    const screen = await renderAuth(<LoginScreen />);
    await screen.findByText("Available in installed builds");

    // The controls are the shared plated input, not a field cut only for auth.
    expect(screen.getByTestId("login-email-focus-halo")).toBeTruthy();
    // No card returns between the ground and the form printed on it.
    expect(screen.queryByTestId("auth-plate")).toBeNull();
    // Sign-in carries no server switch of its own any more.
    expect(screen.queryByTestId("login-server")).toBeNull();
  });

  it("sets the masthead as a poster line, not a card heading", async () => {
    const screen = await renderAuth(<LoginScreen />);
    const heading = await screen.findByRole("header", { name: "Enter the circle" });
    const style = StyleSheet.flatten(heading.props["style"]) as {
      fontFamily?: string;
      fontSize?: number;
      textTransform?: string;
    };

    // 390pt-wide test viewport: the clamp has to be resolving, not falling back
    // to the body scale the shared Text variant starts from.
    expect(style.fontSize).toBeGreaterThanOrEqual(36);
    expect(style.fontFamily).toBe(fontFamily.posterLight);
    expect(style.textTransform).toBe("uppercase");
  });

  it("keeps signup and reset password boundaries distinct", () => {
    expect(validateSignupForm("person@example.com", "1234567", "", false).password).toBe(
      "Use at least 8 characters.",
    );
    expect(validateSignupForm("person@example.com", "12345678", "", false).password).toBeNull();
    expect(validateResetPasswordForm("12345678901", "12345678901").password).toBe(
      "Use at least 12 characters.",
    );
    expect(validateResetPasswordForm("123456789012", "different").confirm).toBe(
      "Both passwords must match.",
    );
  });

  it.each(["this link is no longer valid", "this link has expired"])(
    "surfaces reset failure distinctly: %s",
    async (message) => {
      jest
        .mocked(confirmPasswordReset)
        .mockRejectedValueOnce(new ApiError(400, "http_400", message));
      const screen = await renderAuth(<ResetPasswordScreen token="valid-reset-token" />);
      await fireEvent.changeText(screen.getByTestId("reset-new-password"), "123456789012");
      await fireEvent.changeText(screen.getByTestId("reset-confirm-password"), "123456789012");
      await fireEvent.press(screen.getByRole("button", { name: "Set new password" }));

      await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    },
  );
});

describe("OAuth unavailable state", () => {
  it("renders configured providers disabled with a visible reason", async () => {
    const screen = await renderAuth(
      <OAuthButtons providers={[{ id: "google", name: "Google" }]} />,
    );

    expect(
      screen.getByRole("button", { name: "Continue with Google" }).props["accessibilityState"],
    ).toMatchObject({ disabled: true });
    expect(screen.getByText("Available in installed builds")).toBeTruthy();
  });

  it("renders nothing when no providers are configured", async () => {
    const screen = await renderAuth(<OAuthButtons providers={[]} />);
    expect(screen.queryByText("Available in installed builds")).toBeNull();
    expect(screen.queryByText("OR USE EMAIL")).toBeNull();
  });
});

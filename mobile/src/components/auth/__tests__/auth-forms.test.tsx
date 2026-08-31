import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import type { PropsWithChildren, ReactElement } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { EmailLoginScreen } from "@/components/auth/email-login-form";
import { LoginScreen } from "@/components/auth/login-form";
import { OAuthButtons } from "@/components/auth/oauth-buttons";
import {
  ResetPasswordScreen,
  validateResetPasswordForm,
} from "@/components/auth/reset-password-form";
import { validateSignupForm } from "@/components/auth/signup-form";
import { ApiError } from "@/data/api/client";
import { confirmPasswordReset, getAuthConfig, logIn } from "@/data/api/endpoints/auth";
import { signInWithProvider } from "@/lib/oauth";
import { fontFamily, ThemeProvider } from "@/theme";

const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockBack = jest.fn();
const mockCanGoBack = jest.fn(() => true);

jest.mock("@/lib/oauth", () => ({ signInWithProvider: jest.fn() }));
// The Apple sheet is iOS-only and the test renderer is not a device, so the
// button is absent here by default; its own suite drives the available case.
jest.mock("@/lib/apple-auth", () => ({
  isAppleSignInAvailable: jest.fn(async () => false),
  signInWithAppleNatively: jest.fn(),
}));

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
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider initialMetrics={METRICS}>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ root: { flex: 1 } });

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
      billing: { enabled: false, free_host_limit: 1, mobile_upgrade_link: false },
    });
  });

  it("sends the email option to its own page rather than printing the form", async () => {
    const screen = await renderAuth(<LoginScreen />);
    await screen.findByRole("button", { name: "Continue with Google" });
    expect(screen.queryByTestId("login-email")).toBeNull();

    await fireEvent.press(screen.getByRole("button", { name: "Continue with email" }));

    expect(mockPush).toHaveBeenCalledWith("/login-email");
  });

  it("blocks invalid login input and shows the shared exact validation copy", async () => {
    const screen = await renderAuth(<EmailLoginScreen />);
    // Pushed over the sign-in screen, so it carries the way back.
    expect(screen.getByTestId("auth-back")).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId("login-email"), "not-an-email");
    await fireEvent.changeText(screen.getByTestId("login-password"), "secret");
    await fireEvent.press(screen.getByTestId("login-submit"));

    expect(await screen.findByText("Enter a valid email address.")).toBeTruthy();
    expect(logIn).not.toHaveBeenCalled();
  });

  it("offers the ways in as one set of buttons, over the server they sign in to", async () => {
    const screen = await renderAuth(<LoginScreen />);
    await screen.findByRole("button", { name: "Continue with Google" });

    // Which spawnd first: the hosted one by default, your own on the other tab.
    expect(screen.getByTestId("login-server")).toBeTruthy();
    expect(screen.getByText("spawnd.dev")).toBeTruthy();
    expect(screen.getByText("Self-hosted")).toBeTruthy();
    expect(screen.queryByTestId("login-server-url")).toBeNull();
    // Email is one option among the others, not a form the others sit under.
    expect(screen.getByRole("button", { name: "Continue with email" })).toBeTruthy();
    expect(screen.queryByTestId("login-password")).toBeNull();
    // No card returns between the ground and what is printed on it.
    expect(screen.queryByTestId("auth-plate")).toBeNull();
  });

  it("opens the server field on the self-hosted tab", async () => {
    const screen = await renderAuth(<LoginScreen />);
    await screen.findByRole("button", { name: "Continue with Google" });

    await fireEvent.press(screen.getByText("Self-hosted"));

    expect(await screen.findByTestId("login-server-url")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use this server" })).toBeTruthy();
    // Nothing to sign in to yet: the ways in, and the account link with them,
    // stay off the sheet until the new server has answered.
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue with email" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create one" })).toBeNull();
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

describe("OAuth buttons", () => {
  it("offers each configured provider as a live control", async () => {
    const screen = await renderAuth(
      <OAuthButtons providers={[{ id: "google", name: "Google" }]} />,
    );

    const button = await screen.findByRole("button", { name: "Continue with Google" });
    expect(button.props["accessibilityState"]).toMatchObject({ disabled: false });
  });

  it("starts the provider flow and reports a failure in place", async () => {
    jest.mocked(signInWithProvider).mockResolvedValueOnce({
      status: "failed",
      message: "Google rejected the authorization code",
    });
    const screen = await renderAuth(
      <OAuthButtons providers={[{ id: "google", name: "Google" }]} />,
    );

    await fireEvent.press(await screen.findByRole("button", { name: "Continue with Google" }));

    expect(signInWithProvider).toHaveBeenCalledWith("google", { invite: null });
    expect(await screen.findByText("Google rejected the authorization code")).toBeTruthy();
  });

  it("says nothing when the user backs out of the web view", async () => {
    jest.mocked(signInWithProvider).mockResolvedValueOnce({ status: "cancelled" });
    const screen = await renderAuth(
      <OAuthButtons providers={[{ id: "google", name: "Google" }]} />,
    );

    await fireEvent.press(await screen.findByRole("button", { name: "Continue with Google" }));

    await waitFor(() => expect(signInWithProvider).toHaveBeenCalled());
    // A cancellation is a non-event: no error copy appears under the buttons.
    expect(screen.queryByText(/could not|failed|rejected/i)).toBeNull();
  });

  it("renders nothing when no providers are configured", async () => {
    const screen = await renderAuth(<OAuthButtons providers={[]} />);
    expect(screen.queryByRole("button", { name: "Continue with Google" })).toBeNull();
    expect(screen.queryByText("OR USE EMAIL")).toBeNull();
  });
});

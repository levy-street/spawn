import { act, render, screen } from "@testing-library/react-native";

import { UploadProgressBar } from "@/components/terminal-ui/upload-progress-bar";
import {
  UPLOAD_PROGRESS_FADE_MS,
  UPLOAD_PROGRESS_MIN_VISIBLE_MS,
} from "@/terminal/transport/upload";
import { ThemeProvider } from "@/theme";

describe("terminal upload progress rendering", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("holds completion, fades, and unmounts on the upload state-machine schedule", async () => {
    const view = await render(
      <ThemeProvider>
        <UploadProgressBar ratio={0} />
      </ThemeProvider>,
    );
    await act(async () => jest.advanceTimersByTime(0));
    expect(screen.getByTestId("terminal-upload-progress")).toBeOnTheScreen();

    await view.rerender(
      <ThemeProvider>
        <UploadProgressBar ratio={null} />
      </ThemeProvider>,
    );
    await act(async () => jest.advanceTimersByTime(UPLOAD_PROGRESS_MIN_VISIBLE_MS - 1));
    expect(screen.getByTestId("terminal-upload-progress")).toBeOnTheScreen();
    await act(async () => jest.advanceTimersByTime(1));
    expect(screen.getByTestId("terminal-upload-progress")).toBeOnTheScreen();
    await act(async () => jest.advanceTimersByTime(UPLOAD_PROGRESS_FADE_MS));
    expect(screen.queryByTestId("terminal-upload-progress")).not.toBeOnTheScreen();
  });

  test("a new upload interrupts the completion hold", async () => {
    const view = await render(
      <ThemeProvider>
        <UploadProgressBar ratio={0.5} />
      </ThemeProvider>,
    );
    await view.rerender(
      <ThemeProvider>
        <UploadProgressBar ratio={null} />
      </ThemeProvider>,
    );
    await view.rerender(
      <ThemeProvider>
        <UploadProgressBar ratio={0.25} />
      </ThemeProvider>,
    );
    await act(async () =>
      jest.advanceTimersByTime(UPLOAD_PROGRESS_MIN_VISIBLE_MS + UPLOAD_PROGRESS_FADE_MS),
    );
    expect(screen.getByTestId("terminal-upload-progress")).toBeOnTheScreen();
  });
});

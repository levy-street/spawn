import { QueryClient, type QueryClientConfig, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, type RenderResult, render } from "@testing-library/react-native";
import type { PropsWithChildren, ReactElement } from "react";

import { ThemeProvider } from "@/theme";

export function createTestQueryClient(config: QueryClientConfig = {}): QueryClient {
  return new QueryClient({
    ...config,
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
      ...config.defaultOptions,
    },
  });
}

export interface TestRenderOptions extends Omit<RenderOptions, "wrapper"> {
  queryClient?: QueryClient;
}

export type TestRenderResult = RenderResult & { queryClient: QueryClient };

export async function renderWithProviders(
  element: ReactElement,
  options: TestRenderOptions = {},
): Promise<TestRenderResult> {
  const { queryClient = createTestQueryClient(), ...renderOptions } = options;

  function Providers({ children }: PropsWithChildren): ReactElement {
    return (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>{children}</ThemeProvider>
      </QueryClientProvider>
    );
  }

  const result = await render(element, { ...renderOptions, wrapper: Providers });
  return Object.assign(result, { queryClient });
}

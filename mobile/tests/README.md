# Mobile test support

Import these files directly from a suite; there is intentionally no barrel module.

- `tests/factories.ts` builds fresh workspace, tab, session, host, and agent domain objects. Pass a
  partial object to override only the fields relevant to a test.
- `tests/fake-api.ts` provides a route-based `fetch` double. Register every expected method/path,
  call `install()`, and invoke the returned restore function in cleanup. Unregistered requests
  reject immediately.
- `tests/fake-socket.ts` provides a controllable `FakeWebSocket` and an optional global installer.
  Installed sockets never contact a server and expose captured sends and explicit lifecycle
  controls.
- `tests/fake-transport.ts` implements `SessionTransport`, records writes/resizes/replays/uploads,
  and exposes explicit state, title, bell, scroll, diagnostic, and upload controls.
- `tests/render.tsx` exports `renderWithProviders()` for a fresh QueryClient inside the spawn
  `ThemeProvider`, plus `createTestQueryClient()` when a suite needs to seed query data first.

`tests/setup.ts` blocks unmocked `fetch` and `WebSocket` access and restores real timers after every
test. A suite that intentionally exercises either protocol must install a fake locally. Secure
Store, AsyncStorage, and haptics are mocked globally; feature-specific Expo APIs stay local to the
suite that uses them.

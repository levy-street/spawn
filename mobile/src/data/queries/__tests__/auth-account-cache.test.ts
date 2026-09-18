import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { adoptAuthenticatedAccount } from "@/data/queries/auth";
import { qk } from "@/data/queryKeys";

jest.mock("@/lib/push", () => ({ unregisterForPushNotifications: jest.fn() }));
const USER_B = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "new@example.com",
  created_at: "2026-08-22T00:00:00Z",
  email_verified_at: "2026-08-22T00:00:00Z",
  is_admin: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("login clears disabled observed and unobserved prior-account data and ignores an active late old fetch", async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  const activeKey = ["workspaces"];
  const disabledKey = ["host-private-details"];
  const unobservedKey = ["previous-account-private"];
  client.setQueryData(activeKey, { account: "old", secret: "previous workspaces" });
  client.setQueryData(disabledKey, { account: "old", secret: "previous disabled view" });
  client.setQueryData(unobservedKey, { account: "old", secret: "previous unmounted view" });
  const old = deferred<{ account: string; secret: string }>();
  const current = deferred<{ account: string; secret: string }>();
  let account = "old";
  const calls: string[] = [];
  const seen: unknown[] = [];
  const active = new QueryObserver(client, {
    queryKey: activeKey,
    queryFn: () => {
      calls.push(account);
      return account === "old" ? old.promise : current.promise;
    },
  });
  const disabledFetch = jest.fn(async () => ({
    account: "old",
    secret: "should never refetch disabled view",
  }));
  const disabled = new QueryObserver(client, {
    queryKey: disabledKey,
    enabled: false,
    queryFn: disabledFetch,
  });
  const unsubscribeActive = active.subscribe((result) => seen.push(result.data));
  const unsubscribeDisabled = disabled.subscribe(() => {});
  try {
    await tick();
    expect(calls).toEqual(["old"]);
    account = "new";
    let adopted = false;
    const adopting = Promise.resolve(adoptAuthenticatedAccount(client, USER_B)).then(() => {
      adopted = true;
    });
    expect(client.getQueryData(disabledKey)).toBeUndefined();
    expect(disabled.getCurrentResult().data).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: disabledKey })?.getObserversCount()).toBe(1);
    expect(client.getQueryData(unobservedKey)).toBeUndefined();
    expect(disabledFetch).not.toHaveBeenCalled();
    expect(client.getQueryData(qk.me())).toEqual({ user: USER_B });
    await tick();
    expect(adopted).toBe(false);
    const boundary = seen.length;
    current.resolve({ account: "new", secret: "current workspaces" });
    await adopting;
    expect(adopted).toBe(true);
    expect(calls).toEqual(["old", "new"]);
    old.resolve({ account: "old", secret: "late previous workspaces" });
    await tick();
    expect(client.getQueryData(activeKey)).toEqual({
      account: "new",
      secret: "current workspaces",
    });
    expect(client.getQueryData(qk.me())).toEqual({ user: USER_B });
    expect(seen.slice(boundary).filter(Boolean)).toEqual([
      { account: "new", secret: "current workspaces" },
    ]);
  } finally {
    unsubscribeActive();
    unsubscribeDisabled();
    client.clear();
    old.resolve({ account: "old", secret: "cleanup" });
    current.resolve({ account: "new", secret: "cleanup" });
  }
});

test("a disabled mounted query cannot restore prior-account data when its pending manual fetch completes", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const key = ["disabled-private"];
  client.setQueryData(key, { account: "old" });
  const old = deferred<{ account: string }>();
  const seen: unknown[] = [];
  const observer = new QueryObserver(client, {
    queryKey: key,
    enabled: false,
    queryFn: () => old.promise,
  });
  const unsubscribe = observer.subscribe((result) => seen.push(result.data));
  const fetching = observer.refetch();
  try {
    await tick();
    adoptAuthenticatedAccount(client, USER_B);
    expect(observer.getCurrentResult().data).toBeUndefined();
    const boundary = seen.length;
    old.resolve({ account: "old" });
    await fetching;
    await tick();
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryCache().find({ queryKey: key })?.getObserversCount()).toBe(1);
    expect(seen.slice(boundary).filter(Boolean)).toEqual([]);
  } finally {
    unsubscribe();
    client.clear();
    old.resolve({ account: "old" });
  }
});

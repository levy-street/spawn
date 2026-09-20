import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { cachedListItem } from "./cached-list-item";

const client = new QueryClient();
afterEach(() => client.clear());

test("a session never opened before is immediately available from its host list", async () => {
  const row = { id: "session", host_id: "host", status: "running" };
  const updatedAt = Date.now() - 1_000;
  client.setQueryData(["sessions", { host_id: "host" }], [row], { updatedAt });
  const fetch = () => {
    throw new Error("Opening known metadata must not wait for HTTP");
  };
  const result = await client.fetchQuery({
    queryKey: ["session", row.id],
    queryFn: fetch,
    staleTime: 30_000,
    ...cachedListItem<typeof row>(client, ["sessions"], row.id),
  });
  expect(result).toEqual(row);
  expect(client.getQueryState(["session", row.id])?.dataUpdatedAt).toBe(updatedAt);
});

test("the newest fresh matching list wins, including the account's host connection list", () => {
  const now = Date.now();
  client.setQueryData(["hosts"], [{ id: "host", name: "old" }], { updatedAt: now - 1_000 });
  client.setQueryData(["hosts", "daemon-connections", "account"], [{ id: "host", name: "new" }], {
    updatedAt: now,
  });
  expect(
    cachedListItem<{ id: string; name: string }>(client, ["hosts"], "host").initialData,
  ).toEqual({
    id: "host",
    name: "new",
  });
});

test("expired, invalidated, missing and account-cleared metadata require a real lookup", async () => {
  client.setQueryData(["sessions"], [{ id: "old" }], { updatedAt: Date.now() - 60_000 });
  expect(cachedListItem(client, ["sessions"], "old")).toEqual({});
  client.setQueryData(["sessions"], [{ id: "current" }]);
  expect(cachedListItem(client, ["sessions"], "missing")).toEqual({});
  await client.invalidateQueries({ queryKey: ["sessions"] });
  expect(cachedListItem(client, ["sessions"], "current")).toEqual({});
  client.setQueryData(["sessions"], [{ id: "current" }]);
  client.clear();
  expect(cachedListItem(client, ["sessions"], "current")).toEqual({});
});

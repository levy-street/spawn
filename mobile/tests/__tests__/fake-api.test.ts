import { FakeApi } from "../fake-api";

describe("FakeApi", () => {
  it("matches routes, captures requests, and returns configured responses", async () => {
    const fake = new FakeApi().route("POST", /^\/api\/workspaces\?archived=false$/, (request) => ({
      status: 201,
      json: { accepted: request.headers.get("Authorization") },
    }));
    const restore = fake.install();

    try {
      const response = await fetch("https://api.spawn.test/api/workspaces?archived=false", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" },
        body: JSON.stringify({ name: "Native" }),
      });

      await expect(response.json()).resolves.toEqual({ accepted: "Bearer test-token" });
      expect(response.status).toBe(201);
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]).toMatchObject({
        method: "POST",
        body: '{"name":"Native"}',
      });
    } finally {
      restore();
    }
  });

  it("fails closed for an unregistered request instead of reaching the network", async () => {
    const fake = new FakeApi();
    const original = globalThis.fetch;
    const restore = fake.install();

    await expect(fetch("https://api.spawn.test/unregistered")).rejects.toThrow(
      "Unexpected API request: GET /unregistered",
    );
    expect(fake.requests).toHaveLength(1);

    restore();
    restore();
    expect(globalThis.fetch).toBe(original);
  });
});

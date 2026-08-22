import { singleRouteParam } from "@/components/auth/route-param";

describe("singleRouteParam", () => {
  it("consumes the first deep-link parameter without retaining the URL", () => {
    expect(singleRouteParam(["first-token", "second-token"])).toBe("first-token");
    expect(singleRouteParam("one-token")).toBe("one-token");
  });

  it("normalizes missing and empty values", () => {
    expect(singleRouteParam(undefined)).toBeUndefined();
    expect(singleRouteParam("")).toBeUndefined();
  });
});

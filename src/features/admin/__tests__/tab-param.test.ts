import { describe, expect, it } from "vitest";
import { hrefWithTab, tabFrom } from "../tab-param";

const TABS = ["providers", "models", "routing"] as const;

describe("tabFrom", () => {
  it("合法值照用,缺省或非法回到默认", () => {
    expect(tabFrom("routing", TABS, "providers")).toBe("routing");
    expect(tabFrom(null, TABS, "providers")).toBe("providers");
    expect(tabFrom("", TABS, "providers")).toBe("providers");
    expect(tabFrom("bogus", TABS, "providers")).toBe("providers");
  });
});

describe("hrefWithTab", () => {
  it("只改 tab,保留其余参数;默认页签不写进地址", () => {
    expect(hrefWithTab("/admin/ops", "agent=x", "runs", "usage")).toBe(
      "/admin/ops?agent=x&tab=runs",
    );
    expect(hrefWithTab("/admin/ops", "tab=runs&agent=x", "usage", "usage")).toBe(
      "/admin/ops?agent=x",
    );
    expect(hrefWithTab("/admin/models", "", "providers", "providers")).toBe("/admin/models");
    expect(hrefWithTab("/admin/models", "tab=models", "routing", "providers")).toBe(
      "/admin/models?tab=routing",
    );
  });
});

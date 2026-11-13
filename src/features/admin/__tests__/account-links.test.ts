import { describe, expect, it } from "vitest";
import { accountRecordLinks, filterParam } from "../account-links";

describe("accountRecordLinks:账号详情抽屉的「相关记录」都带上这个账号", () => {
  it("积分账户 / 平台运行 / 操作记录分别带账号、账号筛选、操作者筛选", () => {
    const links = accountRecordLinks("u-40409439");
    expect(links.billing).toBe("/admin/billing?tab=accounts&account=u-40409439");
    expect(links.runs).toBe("/admin/ops?tab=runs&account=u-40409439");
    expect(links.audit).toBe("/admin/ops?tab=audit&actor=u-40409439");
  });

  it("目标页从地址读回的正是抽屉里的账号,不会落到列表第一个", () => {
    const id = "6f1c2d3e-aaaa-bbbb-cccc-000000000001";
    const links = accountRecordLinks(id);
    const read = (href: string, key: "account" | "actor") =>
      filterParam(new URL(href, "http://x").searchParams, key);
    expect(read(links.billing, "account")).toBe(id);
    expect(read(links.runs, "account")).toBe(id);
    expect(read(links.audit, "actor")).toBe(id);
  });

  it("特殊字符会编码,读回来原样", () => {
    const links = accountRecordLinks("a&b=c");
    expect(filterParam(new URL(links.runs, "http://x").searchParams, "account")).toBe("a&b=c");
  });
});

describe("filterParam", () => {
  it("没有或为空时返回空串(= 全部)", () => {
    expect(filterParam(new URLSearchParams(""), "account")).toBe("");
    expect(filterParam(new URLSearchParams("account="), "account")).toBe("");
    expect(filterParam(new URLSearchParams("account=%20%20"), "account")).toBe("");
    expect(filterParam(null, "actor")).toBe("");
  });
});

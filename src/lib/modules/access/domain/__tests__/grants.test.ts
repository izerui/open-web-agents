import {
  type Grant,
  PUBLIC_PRINCIPAL,
  type Subject,
  filterVisible,
  hasResourceAccess,
  isPublic,
} from "@/lib/modules/access/domain/grants";
import { describe, expect, it } from "vitest";

const owner: Subject = { userId: "u-owner" };
const other: Subject = { userId: "u-other" };
const admin: Subject = { userId: "u-admin", role: "admin" };
const grouped: Subject = { userId: "u-g", groupIds: ["team-a"] };

const asst = { id: "a1", ownerId: "u-owner" };

const grant = (over: Partial<Grant> = {}): Grant => ({
  id: "g1",
  resourceType: "agent",
  resourceId: "a1",
  principalType: "user",
  principalId: "u-other",
  permission: "read",
  ...over,
});

describe("hasResourceAccess / owner 与 admin", () => {
  it("owner 恒有读写权,无需授权记录", () => {
    expect(hasResourceAccess(owner, asst, "read", [])).toBe(true);
    expect(hasResourceAccess(owner, asst, "write", [])).toBe(true);
  });

  it("admin 恒有权 —— 需能接管无人维护的智能体", () => {
    expect(hasResourceAccess(admin, asst, "write", [])).toBe(true);
  });

  it("无关用户没有授权则无权", () => {
    expect(hasResourceAccess(other, asst, "read", [])).toBe(false);
  });
});

describe("hasResourceAccess / 按用户授权", () => {
  it("授了 read 就能读,但不能写", () => {
    const gs = [grant({ permission: "read" })];
    expect(hasResourceAccess(other, asst, "read", gs)).toBe(true);
    expect(hasResourceAccess(other, asst, "write", gs)).toBe(false);
  });

  it("write 蕴含 read —— 能改的人当然能看", () => {
    const gs = [grant({ permission: "write" })];
    expect(hasResourceAccess(other, asst, "read", gs)).toBe(true);
    expect(hasResourceAccess(other, asst, "write", gs)).toBe(true);
  });

  it("授给别人的记录对本人无效", () => {
    const gs = [grant({ principalId: "someone-else" })];
    expect(hasResourceAccess(other, asst, "read", gs)).toBe(false);
  });

  it("另一个资源的授权不串到本资源", () => {
    const gs = [grant({ resourceId: "a2", permission: "write" })];
    expect(hasResourceAccess(other, asst, "read", gs)).toBe(false);
  });
});

describe("hasResourceAccess / 公开与群组", () => {
  it("principalType=* 视为公开,所有人可读", () => {
    const gs = [grant({ principalType: "*", principalId: PUBLIC_PRINCIPAL })];
    expect(hasResourceAccess(other, asst, "read", gs)).toBe(true);
  });

  it("公开只给 read 时不含 write", () => {
    const gs = [grant({ principalType: "*", principalId: PUBLIC_PRINCIPAL, permission: "read" })];
    expect(hasResourceAccess(other, asst, "write", gs)).toBe(false);
  });

  it("群组授权对组内成员生效", () => {
    const gs = [grant({ principalType: "group", principalId: "team-a" })];
    expect(hasResourceAccess(grouped, asst, "read", gs)).toBe(true);
  });

  it("群组授权对非成员无效", () => {
    const gs = [grant({ principalType: "group", principalId: "team-b" })];
    expect(hasResourceAccess(grouped, asst, "read", gs)).toBe(false);
  });

  it("没有群组信息的用户不匹配任何群组授权", () => {
    const gs = [grant({ principalType: "group", principalId: "team-a" })];
    expect(hasResourceAccess(other, asst, "read", gs)).toBe(false);
  });

  it("多条授权取并集(任一满足即可)", () => {
    const gs = [
      grant({ id: "g1", principalId: "nobody" }),
      grant({ id: "g2", principalId: "u-other", permission: "write" }),
    ];
    expect(hasResourceAccess(other, asst, "write", gs)).toBe(true);
  });
});

describe("filterVisible", () => {
  const list = [
    { id: "mine", ownerId: "u-owner" },
    { id: "shared", ownerId: "u-x" },
    { id: "hidden", ownerId: "u-x" },
    { id: "open", ownerId: "u-x" },
  ];
  const gs: Grant[] = [
    grant({ id: "g1", resourceId: "shared", principalId: "u-owner" }),
    grant({ id: "g2", resourceId: "open", principalType: "*", principalId: PUBLIC_PRINCIPAL }),
  ];

  it("只留下自己的、被分享的与公开的", () => {
    expect(filterVisible(owner, list, gs).map((r) => r.id)).toEqual(["mine", "shared", "open"]);
  });

  it("admin 看得到全部", () => {
    expect(filterVisible(admin, list, gs)).toHaveLength(4);
  });

  it("无授权的普通用户只看到公开的", () => {
    expect(filterVisible(other, list, gs).map((r) => r.id)).toEqual(["open"]);
  });

  it("空列表返回空", () => {
    expect(filterVisible(owner, [], gs)).toEqual([]);
  });
});

describe("isPublic", () => {
  it("有公开授权即为公开", () => {
    expect(isPublic("a1", [grant({ principalType: "*", principalId: PUBLIC_PRINCIPAL })])).toBe(
      true,
    );
  });
  it("只有点对点授权不算公开", () => {
    expect(isPublic("a1", [grant()])).toBe(false);
  });
  it("无授权不算公开", () => {
    expect(isPublic("a1", [])).toBe(false);
  });
});

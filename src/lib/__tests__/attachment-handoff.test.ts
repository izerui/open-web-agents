import { describe, expect, it } from "vitest";
import { clearHandedOff, handOffUploaded, handedOffFiles } from "../attachment-handoff";

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("探索首页 → 对话页的附件交接(文件已传进会话工作区,只交接文件名)", () => {
  it("交给哪个会话,只有那个会话读得到;读不删,发送后才清", () => {
    const s = memoryStorage();
    handOffUploaded("s1", ["报销单.pdf"], s);
    expect(handedOffFiles("s2", s)).toEqual([]);
    expect(handedOffFiles("s1", s)).toEqual(["报销单.pdf"]);
    // 刷新页面(再读一次)仍在
    expect(handedOffFiles("s1", s)).toEqual(["报销单.pdf"]);
    clearHandedOff("s1", s);
    expect(handedOffFiles("s1", s)).toEqual([]);
  });

  it("没有会话 id、空列表、存储里是坏数据时都给空", () => {
    const s = memoryStorage();
    expect(handedOffFiles(null, s)).toEqual([]);
    handOffUploaded("s1", ["a.txt"], s);
    handOffUploaded("s1", [], s);
    expect(handedOffFiles("s1", s)).toEqual([]);
    s.setItem("owa.handoff.s3", "{坏");
    expect(handedOffFiles("s3", s)).toEqual([]);
    s.setItem("owa.handoff.s4", JSON.stringify([1, "b.txt"]));
    expect(handedOffFiles("s4", s)).toEqual(["b.txt"]);
  });

  it("没有存储(服务端渲染、隐私模式)时不报错", () => {
    expect(() => handOffUploaded("s1", ["a.txt"], null)).not.toThrow();
    expect(handedOffFiles("s1", null)).toEqual([]);
    expect(() => clearHandedOff("s1", null)).not.toThrow();
  });
});

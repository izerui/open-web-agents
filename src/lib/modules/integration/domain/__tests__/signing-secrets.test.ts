import { signingSecretsOf } from "@/lib/modules/integration/domain/signing-secrets";
import { describe, expect, it } from "vitest";

const dec = (enc: string) => (enc.startsWith("enc:") ? enc.slice(4) : null);

describe("signingSecretsOf", () => {
  it("没配密钥:不签名", () => {
    expect(signingSecretsOf({}, dec, 0)).toBeUndefined();
  });

  it("重叠期内:当前密钥 + 旧密钥;重叠期结束(含正好到点):只剩当前密钥", () => {
    const u = {
      webhookSecretEnc: "enc:new",
      webhookSecretPrevEnc: "enc:old",
      webhookSecretPrevUntil: 1000,
    };
    expect(signingSecretsOf(u, dec, 999)).toEqual({ secret: "new", previousSecret: "old" });
    expect(signingSecretsOf(u, dec, 1000)).toEqual({ secret: "new" });
  });

  it("当前密钥解不开:抛错(不能退化成不签名);旧密钥解不开:只是不带", () => {
    expect(() => signingSecretsOf({ webhookSecretEnc: "bad" }, dec, 0)).toThrow(/无法解密/);
    expect(
      signingSecretsOf(
        { webhookSecretEnc: "enc:new", webhookSecretPrevEnc: "bad", webhookSecretPrevUntil: 10 },
        dec,
        0,
      ),
    ).toEqual({ secret: "new" });
  });
});

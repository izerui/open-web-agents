"use client";

import { useEffect, useState } from "react";
import { fetchJson } from "./fetch-json";

export interface MeUser {
  id: string;
  email: string;
  role: string;
  defaultBaseUrl: string | null;
  anthropicKeyMask: string | null;
}

export interface Me {
  authenticated: boolean;
  /** 平台是否强制登录。关掉时(本地开发)后端会发一个匿名 admin,此时"登出"没有意义。 */
  authRequired?: boolean;
  user?: MeUser;
}

/**
 * 全站共享的登录态。
 *
 * 【为什么不让每个组件各拉各的】侧栏的用户菜单和设置页要的是同一份数据:
 * 各拉各的,进设置页就会打两次 /api/auth;更麻烦的是在设置页改完凭证后,
 * 侧栏里的密钥掩码还停在旧值 —— 同一个事实有两份状态,迟早对不上。
 * 所以这里做成单一来源:一处刷新,所有订阅者一起更新。
 */
let cache: Me | null = null;
/** 正在飞的请求。首屏两个组件同时挂载时共享它,而不是各发一个。 */
let inflight: Promise<Me> | null = null;
const listeners = new Set<(m: Me | null) => void>();

function emit(): void {
  for (const l of listeners) l(cache);
}

async function load(): Promise<Me> {
  inflight ??= fetchJson<Me>("/api/auth").finally(() => {
    inflight = null;
  });
  cache = await inflight;
  emit();
  return cache;
}

/** 重新拉一次并通知所有订阅者。改完凭证后调它,侧栏才会跟着变。 */
export async function refreshMe(): Promise<void> {
  inflight = null;
  await load().catch(() => {
    // 刷新失败保留旧值:显示稍旧的邮箱,好过整块 UI 突然空掉
  });
}

/**
 * 清空登录态。
 *
 * 【为什么登出必须调它】cache 是模块级的,不随路由跳转重置。
 * 不清的话,登出后跳到登录页、再用另一个账号登进来,
 * 侧栏可能还挂着上一个人的邮箱 —— 在多人共用的机器上这是真的会出事。
 */
export function clearMe(): void {
  cache = null;
  inflight = null;
  emit();
}

/** 同步读当前已知的登录态,不触发请求。没拉过或已清空时是 null。 */
export function peekMe(): Me | null {
  return cache;
}

/** 仅供测试:重置模块级状态。 */
export function __resetMe(): void {
  cache = null;
  inflight = null;
  listeners.clear();
}

export function useMe(): { me: Me | null; loading: boolean } {
  const [me, setMe] = useState<Me | null>(cache);
  const [loading, setLoading] = useState(cache === null);

  useEffect(() => {
    listeners.add(setMe);
    if (cache === null) {
      void load()
        .catch(() => {
          // 拿不到登录态不弹 toast:这块只是导航区的一个头像,
          // 为它打断用户手上的事不值当,菜单里降级成"未登录"即可
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    return () => {
      listeners.delete(setMe);
    };
  }, []);

  return { me, loading };
}

/**
 * 邮箱 → 头像里的字母。
 *
 * 【为什么不用 Gravatar】那要把用户邮箱的哈希发给第三方,并且每个头像多一个跨域请求 ——
 * 为了两个字母不值当。分隔符切出来的两段取首字母(li.hua → LH),
 * 切不出来就取前两个字符。
 */
export function initialsOf(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._\-+]+/).filter(Boolean);
  const [first, second] = parts;
  if (first && second) return (first.slice(0, 1) + second.slice(0, 1)).toUpperCase();
  return (first ?? local).slice(0, 2).toUpperCase() || "?";
}

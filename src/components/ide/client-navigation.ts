export const BEFORE_CLIENT_NAVIGATION = "owa:before-client-navigation";

/** Programmatic navigation must offer editors the same veto as an internal link. */
export function requestClientNavigation(href: string, preflightOnly = false): boolean {
  const next = new URL(href, window.location.href);
  if (
    next.origin === window.location.origin &&
    next.pathname === window.location.pathname &&
    next.search === window.location.search
  ) {
    return true;
  }
  return window.dispatchEvent(
    new CustomEvent(BEFORE_CLIENT_NAVIGATION, { cancelable: true, detail: { preflightOnly } }),
  );
}

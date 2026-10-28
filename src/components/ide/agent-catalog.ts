export const AGENT_CATALOG_CHANGED = "owa:agent-catalog-changed";

export function notifyAgentCatalogChanged() {
  window.dispatchEvent(new Event(AGENT_CATALOG_CHANGED));
}

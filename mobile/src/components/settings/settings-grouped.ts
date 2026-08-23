import { createContext, isValidElement, type ReactNode, useContext } from "react";

/**
 * The contract between a settings section and the rows inside it.
 *
 * A section draws one surface — a heading, a rule, hairlines between entries —
 * and the rows inside it draw none of their own. Keeping the context and the
 * row marker here rather than in either component is what lets rows stay
 * unaware of sections and sections stay unaware of every row type.
 */
const SettingsGroupedContext = createContext(false);

export const SettingsGroupedProvider = SettingsGroupedContext.Provider;

/** True when this row is drawn inside a section's grouped list. */
export function useSettingsGrouped(): boolean {
  return useContext(SettingsGroupedContext);
}

const SETTINGS_ROW = Symbol.for("spawn.settings.row");

/**
 * Marks a component as a settings row.
 *
 * A section groups its row children and leaves everything else — buttons,
 * inputs, empty states — in the padded column. It cannot ask "is this a row?"
 * by identity without importing every row type, so rows say so themselves.
 */
export function markSettingsRow<T extends object>(component: T): T {
  return Object.assign(component, { [SETTINGS_ROW]: true });
}

export function isSettingsRow(node: ReactNode): boolean {
  if (!isValidElement(node)) return false;
  const type = node.type;
  if (typeof type !== "function" && typeof type !== "object") return false;
  return (type as unknown as Record<symbol, unknown>)[SETTINGS_ROW] === true;
}

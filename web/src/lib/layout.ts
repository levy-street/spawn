/** Pure operations on screen layout split trees. */

export type LayoutPane = { type: "pane"; agent_id: string };
export type LayoutSplit = {
  type: "split";
  direction: "row" | "column";
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
};
export type LayoutNode = LayoutPane | LayoutSplit;
export type Side = "left" | "right" | "top" | "bottom";
export type SplitPath = ("a" | "b")[];

export const MIN_RATIO = 0.15;
export const MAX_RATIO = 0.85;

export function pane(agentId: string): LayoutPane {
  return { type: "pane", agent_id: agentId };
}

export function split(
  direction: "row" | "column",
  a: LayoutNode,
  b: LayoutNode,
  ratio = 0.5,
): LayoutSplit {
  return { type: "split", direction, ratio, a, b };
}

export function collectAgentIds(node: LayoutNode | null | undefined): string[] {
  if (!node) return [];
  if (node.type === "pane") return [node.agent_id];
  return [...collectAgentIds(node.a), ...collectAgentIds(node.b)];
}

export function countPanes(node: LayoutNode | null | undefined): number {
  return collectAgentIds(node).length;
}

export function removePane(node: LayoutNode | null, agentId: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === "pane") return node.agent_id === agentId ? null : node;
  const a = removePane(node.a, agentId);
  const b = removePane(node.b, agentId);
  if (a === node.a && b === node.b) return node;
  if (!a) return b;
  if (!b) return a;
  return { ...node, a, b };
}

/**
 * Split the target pane, placing the new agent on `side`. A null target (or
 * empty tree) appends at the root instead.
 */
export function insertAtEdge(
  root: LayoutNode | null,
  targetAgentId: string | null,
  side: Side,
  newAgentId: string,
): LayoutNode {
  const fresh = pane(newAgentId);
  if (!root) return fresh;
  if (targetAgentId === null) return joinAtSide(root, fresh, side);

  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === "pane") {
      return node.agent_id === targetAgentId ? joinAtSide(node, fresh, side) : node;
    }
    const a = walk(node.a);
    if (a !== node.a) return { ...node, a };
    const b = walk(node.b);
    if (b !== node.b) return { ...node, b };
    return node;
  };
  return walk(root);
}

function joinAtSide(existing: LayoutNode, added: LayoutNode, side: Side): LayoutSplit {
  const direction = side === "left" || side === "right" ? "row" : "column";
  const addedFirst = side === "left" || side === "top";
  return split(direction, addedFirst ? added : existing, addedFirst ? existing : added);
}

export function swapPanes(root: LayoutNode | null, aId: string, bId: string): LayoutNode | null {
  if (!root || aId === bId) return root;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.type === "pane") {
      if (node.agent_id === aId) return pane(bId);
      if (node.agent_id === bId) return pane(aId);
      return node;
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  return walk(root);
}

/** Move an existing pane next to another pane (or swap via `center`). */
export function movePane(
  root: LayoutNode | null,
  sourceId: string,
  targetId: string,
  side: Side | "center",
): LayoutNode | null {
  if (!root || sourceId === targetId) return root;
  if (side === "center") return swapPanes(root, sourceId, targetId);
  const without = removePane(root, sourceId);
  if (!without) return root;
  return insertAtEdge(without, targetId, side, sourceId);
}

export function nodeAt(root: LayoutNode | null, path: SplitPath): LayoutNode | null {
  let node: LayoutNode | null = root;
  for (const step of path) {
    if (!node || node.type !== "split") return null;
    node = node[step];
  }
  return node;
}

export function setRatioAt(
  root: LayoutNode | null,
  path: SplitPath,
  ratio: number,
): LayoutNode | null {
  if (!root) return null;
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const walk = (node: LayoutNode, depth: number): LayoutNode => {
    if (node.type !== "split") return node;
    if (depth === path.length) return { ...node, ratio: clamped };
    const step = path[depth];
    if (step === undefined) return node;
    return { ...node, [step]: walk(node[step], depth + 1) };
  };
  return walk(root, 0);
}

// ---------------------------------------------------------------------------
// Arrangement presets — rebuild the tree from the current pane order.
// ---------------------------------------------------------------------------

export function buildEven(agentIds: string[], direction: "row" | "column"): LayoutNode | null {
  if (agentIds.length === 0) return null;
  if (agentIds.length === 1) return pane(agentIds[0]);
  const [first, ...rest] = agentIds;
  return split(
    direction,
    pane(first),
    buildEven(rest, direction) as LayoutNode,
    Math.min(MAX_RATIO, Math.max(MIN_RATIO, 1 / agentIds.length)),
  );
}

export function buildMainStack(agentIds: string[]): LayoutNode | null {
  if (agentIds.length <= 1) return buildEven(agentIds, "row");
  const [main, ...rest] = agentIds;
  return split("row", pane(main), buildEven(rest, "column") as LayoutNode, 0.6);
}

export function buildGrid(agentIds: string[]): LayoutNode | null {
  if (agentIds.length === 0) return null;
  if (agentIds.length <= 2) return buildEven(agentIds, "row");
  const perRow = Math.ceil(agentIds.length / Math.ceil(agentIds.length / 2));
  const rows: LayoutNode[] = [];
  for (let i = 0; i < agentIds.length; i += perRow) {
    rows.push(buildEven(agentIds.slice(i, i + perRow), "row") as LayoutNode);
  }
  let result = rows[rows.length - 1];
  for (let i = rows.length - 2; i >= 0; i -= 1) {
    result = split("column", rows[i], result, 1 / (rows.length - i));
  }
  return result;
}

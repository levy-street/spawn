/**
 * What the move dialog checks before anything stops (about a second, shown
 * as "Checking dream and mac…"), and what it then says. Reads only: the
 * source's `conv.inspect` (which conversation, and running, blocked or idle
 * right now) and `agent.transcripts` (how big, and nothing over the per-file
 * cap), the target's `conv.probe` (store, folder, live copies, shell, memory
 * folder, Claude Code's version), the target's own Claude Code settings
 * (for the mode the picker starts on), and `.git/HEAD` on both through
 * `fs.read`.
 *
 * The window's conversation and state are sampled again when the person
 * confirms (`MovePlan`): the conversation it is in then is the one that
 * goes, and the note follows the state it was in then.
 */

import {
  type ConversationInspection,
  type ConversationState,
  canonicalConversationId,
} from "@/lib/conversation";
import type { AgentTranscriptQuery, AgentTranscriptReport } from "@/lib/hostControl";
import type { ConversationProbe } from "./conv";
import {
  checkFailedBlock,
  claudeNotFoundWarning,
  differentCommitWarning,
  duplicateNote,
  durationWarning,
  folderMissingBlock,
  formatDuration,
  headLabel,
  liveElsewhereBlock,
  liveHereBlock,
  moveBody,
  moveTitle,
  NO_CONVERSATION_BLOCK,
  notARepositoryWarning,
  olderClaudeWarning,
  SWITCHED_CONVERSATION_NOTE,
  sameCommitLine,
  stateLine,
  storeNotReadyBlock,
  TOO_LARGE_BLOCK,
  UNCONFIRMED_CONVERSATION_WARNING,
} from "./copy";
import { estimateSeconds, type LegInfo, SHOW_ESTIMATE_SECONDS } from "./estimate";
import { type GitHead, type ReadText, readGitHead, sameHead } from "./git-head";
import { readTargetSettings } from "./permission-modes";

/**
 * The per-file cap a move refuses above — the only size a move refuses
 * (OD3 as the owner decided it: carry everything, say how long it will
 * take, refuse only what the source cannot carry).
 */
export const MOVE_FILE_CAP_BYTES = 512 * 1024 * 1024;

export interface PreflightSource {
  inspect(sessionId: string): Promise<ConversationInspection>;
  transcripts(query: AgentTranscriptQuery): Promise<AgentTranscriptReport>;
  readText: ReadText;
}

export interface PreflightTarget {
  probe(query: { conversationId: string | null; cwd: string }): Promise<ConversationProbe>;
  readText: ReadText;
}

export interface MoveFacts {
  inspection: ConversationInspection | null;
  /** The conversation that travels: the one the window is in now, else the recorded one. */
  conversationId: string | null;
  /** The window is in another conversation than the recorded one. */
  switched: boolean;
  /** The host answered for the window's Claude Code but could not name its
   *  conversation: the recorded one goes. */
  unconfirmed: boolean;
  /** The target's Claude Code settings file, as text, or null. */
  settings: string | null;
  state: ConversationState;
  /** What the conversation's own files add up to, or null when unknown. */
  bytes: number | null;
  tooLarge: boolean;
  probe: ConversationProbe | null;
  sourceHead: GitHead | null;
  targetHead: GitHead | null;
  /** How long the carry should take, or null when the size is unknown. */
  seconds: number | null;
}

export async function gatherMoveFacts({
  sessionId,
  recordedConversationId,
  sourceCwd,
  targetCwd,
  source,
  target,
  legs,
}: {
  sessionId: string;
  recordedConversationId: string | null;
  sourceCwd: string;
  targetCwd: string;
  source: PreflightSource;
  target: PreflightTarget;
  legs: readonly LegInfo[];
}): Promise<MoveFacts> {
  // A stopped window answers `session_not_found`: nothing runs to ask.
  const inspection = await source.inspect(sessionId).catch(() => null);
  const live =
    inspection?.agent === "claude-code" || inspection?.agent === null
      ? canonicalConversationId(inspection?.conversation_id)
      : null;
  const recorded = canonicalConversationId(recordedConversationId);
  const conversationId = live ?? recorded;
  const [report, probed, sourceHead, targetHead] = await Promise.all([
    conversationId
      ? source
          .transcripts({ agentKind: "claude-code", conversationId, cwd: sourceCwd })
          .catch(() => null)
      : Promise.resolve(null),
    target
      .probe({ conversationId, cwd: targetCwd })
      .then(async (probe) => ({
        probe,
        settings: await readTargetSettings(probe.store, target.readText),
      }))
      .catch(() => null),
    readGitHead(source.readText, sourceCwd).catch(() => null),
    readGitHead(target.readText, targetCwd).catch(() => null),
  ]);
  const probe = probed?.probe ?? null;
  const files =
    report?.supported === true
      ? report.transcripts.filter(
          (file) => file.conversation_id === conversationId || file.role !== "input",
        )
      : [];
  const bytes = files.length > 0 ? files.reduce((sum, file) => sum + file.size, 0) : null;
  return {
    inspection,
    conversationId,
    switched: live !== null && recorded !== null && live !== recorded,
    unconfirmed:
      inspection?.agent === "claude-code" &&
      canonicalConversationId(inspection.conversation_id) === null &&
      recorded !== null,
    settings: probed?.settings ?? null,
    state: inspection?.state ?? "unknown",
    bytes,
    tooLarge: files.some((file) => file.size > MOVE_FILE_CAP_BYTES),
    probe,
    sourceHead,
    targetHead,
    seconds: bytes !== null ? estimateSeconds(bytes, legs) : null,
  };
}

function olderVersion(a: string, b: string): boolean {
  const parse = (value: string) => value.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x < y;
  }
  return false;
}

export interface MoveDialogModel {
  title: string;
  body: string;
  stateLine: string;
  /** "Both are on main at 1a2b3c4." when the folders agree. */
  folderLine: string | null;
  /** Amber: worth knowing before confirming. */
  warnings: string[];
  /** Plain notes. */
  notes: string[];
  /** Any of these, and the move cannot carry the conversation. */
  blocks: string[];
}

export function moveDialogModel(
  facts: MoveFacts,
  names: { source: string; target: string; cwd: string },
): MoveDialogModel {
  const { source, target, cwd } = names;
  const blocks: string[] = [];
  const warnings: string[] = [];
  const notes: string[] = [];
  const probe = facts.probe;
  if (!facts.conversationId) blocks.push(NO_CONVERSATION_BLOCK);
  if (facts.inspection?.live_elsewhere) blocks.push(liveElsewhereBlock(source));
  if (!probe) blocks.push(checkFailedBlock(target));
  else {
    if (probe.live) blocks.push(liveHereBlock(target));
    if (!probe.storeReady) blocks.push(storeNotReadyBlock(target));
    if (!probe.folderExists) blocks.push(folderMissingBlock(target, cwd));
  }
  if (facts.tooLarge) blocks.push(TOO_LARGE_BLOCK);

  let folderLine: string | null = null;
  const { sourceHead, targetHead } = facts;
  if (sourceHead && targetHead) {
    if (sameHead(sourceHead, targetHead) && sourceHead.commit)
      folderLine = sameCommitLine(sourceHead.branch, sourceHead.commit);
    else
      warnings.push(
        differentCommitWarning(
          source,
          headLabel(sourceHead.branch, sourceHead.commit),
          target,
          headLabel(targetHead.branch, targetHead.commit),
        ),
      );
  } else if (sourceHead && probe?.folderExists) {
    warnings.push(notARepositoryWarning(target, cwd));
  }
  if (facts.seconds !== null && facts.seconds > SHOW_ESTIMATE_SECONDS)
    warnings.push(durationWarning(formatDuration(facts.seconds)));
  const sourceVersion = facts.inspection?.cli_version ?? null;
  if (probe && probe.cliVersion === null) warnings.push(claudeNotFoundWarning(target));
  else if (probe?.cliVersion && sourceVersion && olderVersion(probe.cliVersion, sourceVersion))
    warnings.push(olderClaudeWarning(target, probe.cliVersion, source, sourceVersion));
  if (probe && probe.duplicates.length > 0 && !probe.live) notes.push(duplicateNote(target));
  if (facts.unconfirmed) warnings.push(UNCONFIRMED_CONVERSATION_WARNING);
  else if (facts.switched) notes.push(SWITCHED_CONVERSATION_NOTE);

  return {
    title: moveTitle(target),
    body: moveBody(source, target, cwd, facts.bytes),
    stateLine: stateLine(facts.state, target),
    folderLine,
    warnings,
    notes,
    blocks,
  };
}

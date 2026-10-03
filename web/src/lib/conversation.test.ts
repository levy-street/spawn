import { describe, expect, test } from "bun:test";
import { type ConversationInspection, parseConversationInspection } from "@/lib/conversation";

const answer: ConversationInspection = {
  agent: "claude-code",
  conversation_id: "4e0b4642-0972-40ac-9a18-61d542276b76",
  state: "blocked",
  cli_version: "2.1.288",
  live_elsewhere: false,
  source: "registry",
};

describe("parseConversationInspection", () => {
  test("reads a daemon's answer as it is", () => {
    expect(parseConversationInspection(answer)).toEqual(answer);
    const nothing: ConversationInspection = {
      agent: null,
      conversation_id: null,
      state: "unknown",
      cli_version: null,
      live_elsewhere: false,
      source: "none",
    };
    expect(parseConversationInspection(nothing)).toEqual(nothing);
  });

  test("a state this client does not know yet reads as unknown, not as malformed", () => {
    expect(parseConversationInspection({ ...answer, state: "compacting" })?.state).toBe("unknown");
  });

  test("anything else malformed is not an answer", () => {
    for (const bad of [
      null,
      [],
      "registry",
      { ...answer, live_elsewhere: "no" },
      { ...answer, source: 7 },
      { ...answer, conversation_id: "../../etc/passwd" },
      { ...answer, conversation_id: "x".repeat(65) },
      { ...answer, agent: 3 },
      { ...answer, cli_version: "2.1.288 && rm -rf /" },
    ]) {
      expect(parseConversationInspection(bad)).toBeNull();
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  type ConversationInspection,
  canonicalConversationId,
  parseConversationInspection,
} from "@/lib/conversation";

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
      { ...answer, conversation_id: "--dangerously-skip-permissions" },
      { ...answer, conversation_id: "-p" },
      { ...answer, conversation_id: "conv-2" },
      { ...answer, conversation_id: 7 },
      { ...answer, agent: 3 },
      { ...answer, cli_version: "2.1.288 && rm -rf /" },
    ]) {
      expect(parseConversationInspection(bad)).toBeNull();
    }
  });
});

/** Ids a server could hand back that must never reach a command line. */
const ADVERSARIAL = [
  "--dangerously-skip-permissions",
  "-p",
  "--settings=x",
  "-",
  "a b",
  "",
  "conv-2",
  "rm -rf ~",
  "4e0b4642-0972-40ac-9a18-61d542276b7",
  "4e0b4642-0972-40ac-9a18-61d542276b766",
  "4e0b46420972-40ac-9a18-61d542276b76",
  "{4e0b4642-0972-40ac-9a18-61d542276b76}",
  " 4e0b4642-0972-40ac-9a18-61d542276b76",
  "4e0b4642-0972-40ac-9a18-61d542276b76\n",
  "-4e0b4642-0972-40ac-9a18-61d542276b76",
  "4e0b4642-0972-40ac-9a18-61d542276b76 --dangerously-skip-permissions",
  "ge0b4642-0972-40ac-9a18-61d542276b76",
];

describe("canonicalConversationId", () => {
  test("a UUID is an id, read lower-case", () => {
    expect(canonicalConversationId("4e0b4642-0972-40ac-9a18-61d542276b76")).toBe(
      "4e0b4642-0972-40ac-9a18-61d542276b76",
    );
    expect(canonicalConversationId("4E0B4642-0972-40AC-9A18-61D542276B76")).toBe(
      "4e0b4642-0972-40ac-9a18-61d542276b76",
    );
  });

  test("anything else is no id at all", () => {
    for (const value of [...ADVERSARIAL, null, undefined, 7, {}, ["x"]]) {
      expect(canonicalConversationId(value)).toBeNull();
    }
  });

  test("an id from the host in upper case is read lower-case", () => {
    expect(
      parseConversationInspection({
        ...answer,
        conversation_id: "4E0B4642-0972-40AC-9A18-61D542276B76",
      })?.conversation_id,
    ).toBe("4e0b4642-0972-40ac-9a18-61d542276b76");
  });
});

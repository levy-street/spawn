import { canonicalConversationId } from "@/terminal/transport/conversation-id";

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
});

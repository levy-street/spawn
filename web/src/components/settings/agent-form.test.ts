import { describe, expect, test } from "bun:test";
import { agentDraftToInput } from "@/components/settings/agent-form";

describe("agentDraftToInput", () => {
  test("normalizes fields and omits blank environment keys", () => {
    expect(
      agentDraftToInput({
        name: "  Local agent ",
        kind: " custom ",
        command: " my-agent --interactive ",
        install: "  ",
        env: [
          { id: "1", key: " TOKEN ", value: "secret" },
          { id: "2", key: " ", value: "ignored" },
        ],
      }),
    ).toEqual({
      name: "Local agent",
      kind: "custom",
      command: "my-agent --interactive",
      install: null,
      env: { TOKEN: "secret" },
    });
  });

  test("preserves an install command", () => {
    const input = agentDraftToInput({
      name: "Aider",
      kind: "aider",
      command: "aider",
      install: "pipx install aider-chat",
      env: [],
    });

    expect(input.install).toBe("pipx install aider-chat");
  });
});

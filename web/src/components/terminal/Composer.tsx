"use client";

import { Send } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface ComposerProps {
  /** Send the (text + "\r") payload as raw bytes over the agent WS. */
  onSend: (text: string) => void;
  /** "Raw" toggle disables the composer; the Terminal handles keystrokes itself. */
  rawMode: boolean;
  onToggleRaw: (next: boolean) => void;
  disabled?: boolean;
}

/**
 * Mobile-first composer. Enter sends, Shift+Enter inserts newline. On mobile
 * the soft keyboard's IME often swallows the Enter key before keydown -- the
 * Send button is the primary control.
 */
export function Composer({ onSend, rawMode, onToggleRaw, disabled }: ComposerProps) {
  const [value, setValue] = useState("");

  const send = () => {
    if (!value) return;
    onSend(value);
    setValue("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border bg-card/80 p-2 backdrop-blur">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{rawMode ? "Raw input mode (terminal owns keys)" : "Composer mode"}</span>
        <button
          type="button"
          onClick={() => onToggleRaw(!rawMode)}
          className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-accent"
        >
          {rawMode ? "Switch to composer" : "Switch to raw"}
        </button>
      </div>
      {!rawMode && (
        <div className="flex items-end gap-2">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a message... (Enter sends, Shift+Enter newline)"
            rows={2}
            disabled={disabled}
            className="resize-none"
          />
          <Button
            type="button"
            onClick={send}
            disabled={disabled || !value}
            size="icon"
            aria-label="Send"
            title="Send"
          >
            <Send className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

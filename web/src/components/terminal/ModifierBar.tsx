"use client";

import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Clipboard as ClipboardIcon,
  SendHorizontal,
} from "lucide-react";
import { type ClipboardEvent, type FormEvent, type ReactNode, useRef } from "react";
import { cn } from "@/lib/utils";

export interface ModifierBarProps {
  /** Send raw bytes / strings to the agent stdin. */
  onSend: (bytes: Uint8Array | string) => void;
  onPaste?: (data: DataTransfer) => void;
  onPasteText?: (text: string) => void;
  onPasteClick?: () => void;
  onSubmit?: () => void;
  className?: string;
}

interface Key {
  label: ReactNode;
  bytes: string;
  hint?: string;
}

const CONTROL_KEYS: Key[] = [
  { label: "Esc", bytes: "\x1b", hint: "Escape" },
  { label: "Tab", bytes: "\t", hint: "Tab" },
  { label: "^C", bytes: "\x03", hint: "Ctrl-C" },
  { label: <ArrowUp className="size-4" />, bytes: "\x1b[A", hint: "Up" },
  { label: <ArrowDown className="size-4" />, bytes: "\x1b[B", hint: "Down" },
  { label: <ArrowLeft className="size-4" />, bytes: "\x1b[D", hint: "Left" },
  { label: <ArrowRight className="size-4" />, bytes: "\x1b[C", hint: "Right" },
];

const SEND_KEY: Key = {
  label: (
    <>
      <SendHorizontal className="size-4" />
      <span>Send</span>
    </>
  ),
  bytes: "\r",
  hint: "Send",
};

export function ModifierBar({
  onSend,
  onPaste,
  onPasteText,
  onPasteClick,
  onSubmit,
  className,
}: ModifierBarProps) {
  return (
    <div
      className={cn(
        "z-30 flex w-full shrink-0 items-center gap-2 border-t border-border bg-background/95 px-2 py-1 backdrop-blur",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {(onPaste || onPasteClick) && (
          <NativePasteKey onPaste={onPaste} onPasteText={onPasteText} onPasteClick={onPasteClick} />
        )}
        {CONTROL_KEYS.map((k) => (
          <KeyButton key={k.hint} item={k} onSend={onSend} />
        ))}
      </div>
      <KeyButton
        item={SEND_KEY}
        onSend={() => {
          if (onSubmit) onSubmit();
          else onSend(SEND_KEY.bytes);
        }}
        primary
      />
    </div>
  );
}

function NativePasteKey({
  onPaste,
  onPasteText,
  onPasteClick,
}: {
  onPaste?: (data: DataTransfer) => void;
  onPasteText?: (text: string) => void;
  onPasteClick?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const clear = () => {
    if (ref.current) ref.current.value = "";
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onPaste) return;
    event.preventDefault();
    onPaste(event.clipboardData);
    clear();
  };

  const handleInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    const text = textarea.value;
    if (!text) return;
    onPasteText?.(text);
    textarea.value = "";
  };

  const handleClick = () => {
    ref.current?.focus();
    ref.current?.select();
    if (window.isSecureContext) {
      onPasteClick?.();
      return;
    }
    try {
      document.execCommand("paste");
    } catch {
      // Native paste events are the fallback on insecure origins.
    }
  };

  return (
    <div className="relative h-9 min-w-9 shrink-0">
      <textarea
        ref={ref}
        aria-label="Paste"
        title="Paste"
        autoCapitalize="off"
        autoCorrect="off"
        inputMode="none"
        spellCheck={false}
        rows={1}
        onClick={handleClick}
        onPaste={handlePaste}
        onInput={handleInput}
        onFocus={() => {
          ref.current?.select();
        }}
        className="size-9 resize-none overflow-hidden rounded-md border border-border bg-card p-0 text-transparent caret-transparent outline-none active:bg-accent"
      />
      <ClipboardIcon className="pointer-events-none absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 text-foreground" />
    </div>
  );
}

function KeyButton({
  item,
  onSend,
  primary,
}: {
  item: Key;
  onSend: ModifierBarProps["onSend"];
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={item.hint}
      title={item.hint}
      // `onPointerDown` so the terminal's hidden input doesn't lose focus.
      onPointerDown={(e) => {
        e.preventDefault();
        onSend(item.bytes);
      }}
      onClick={(e) => e.preventDefault()}
      tabIndex={-1}
      className={cn(
        "inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1 rounded-md border px-2 text-xs font-medium active:bg-accent",
        primary
          ? "border-primary bg-primary px-3 text-primary-foreground active:bg-primary/90"
          : "border-border bg-card text-foreground",
      )}
    >
      {item.label}
    </button>
  );
}

"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Radix Dialog wrapper — the base for every modal surface (settings, folder
 * picker, confirms). `DialogContent` handles portal, scrim, sizing, and the
 * close affordance; compose the body from `DialogHeader`/`DialogTitle`/
 * `DialogFooter`. Height is capped to the visual viewport (`--vv-height`) so
 * the on-screen keyboard never pushes content off screen.
 */
const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

const contentVariants = cva(
  cn(
    "fixed z-50 flex flex-col overflow-hidden bg-background focus:outline-none",
    "data-[state=open]:animate-in data-[state=open]:fade-in-0",
  ),
  {
    variants: {
      size: {
        // Centered panels; width shrinks with the viewport, height with
        // --vv-height so the keyboard never clips the footer.
        sm: cn(
          "left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2",
          "max-h-[calc(var(--vv-height)-2rem)] rounded-xl border border-border shadow-2xl shadow-black/20 dark:shadow-black/50",
          "data-[state=open]:zoom-in-95",
        ),
        md: cn(
          "left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
          "max-h-[calc(var(--vv-height)-2rem)] rounded-xl border border-border shadow-2xl shadow-black/20 dark:shadow-black/50",
          "data-[state=open]:zoom-in-95",
        ),
        lg: cn(
          "left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2",
          "max-h-[calc(var(--vv-height)-2rem)] rounded-xl border border-border shadow-2xl shadow-black/20 dark:shadow-black/50",
          "data-[state=open]:zoom-in-95",
        ),
        // Full screen on mobile, a large centered panel from md: up — the
        // SettingsDialog treatment, shared by the folder picker.
        "full-mobile": cn(
          "inset-0 pad-safe-top pad-safe-bottom max-h-(--vv-height)",
          "md:inset-auto md:left-1/2 md:top-1/2 md:h-[min(100vh-4rem,680px)] md:w-[min(100vw-3rem,920px)] md:-translate-x-1/2 md:-translate-y-1/2",
          "md:rounded-xl md:border md:border-border md:shadow-2xl md:shadow-black/20 md:dark:shadow-black/50",
          "md:data-[state=open]:zoom-in-95",
        ),
        // The file viewer: `full-mobile` given as much room as the viewport
        // will spare, because the content is the point — a page of a PDF, a
        // video frame, a wide table of code — and cropping it to a settings
        // panel would defeat opening it at all.
        viewer: cn(
          "inset-0 pad-safe-top pad-safe-bottom max-h-(--vv-height)",
          "md:inset-auto md:left-1/2 md:top-1/2 md:h-[min(100vh-3rem,860px)] md:w-[min(100vw-3rem,960px)] md:-translate-x-1/2 md:-translate-y-1/2",
          "md:rounded-xl md:border md:border-border md:shadow-2xl md:shadow-black/20 md:dark:shadow-black/50",
          "md:data-[state=open]:zoom-in-95",
        ),
      },
    },
    defaultVariants: { size: "md" },
  },
);

export type DialogSize = NonNullable<VariantProps<typeof contentVariants>["size"]>;

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof contentVariants> & { hideClose?: boolean }
>(({ size, hideClose = false, className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    {/* Tagged so a dialog holding portaled menus can tell a click on the
        scrim (dismiss) from one on a menu it opened itself (do not). */}
    <DialogPrimitive.Overlay
      data-dialog-overlay=""
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0"
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(contentVariants({ size }), className)}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close asChild>
          <button
            type="button"
            aria-label="Close"
            className="absolute right-3 top-3 mt-[env(safe-area-inset-top)] rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:mt-0"
          >
            <X className="size-4" />
          </button>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("flex shrink-0 flex-col gap-1 p-4 pb-2 pr-12", className)} {...props} />
  );
}

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-sm font-semibold", className)} {...props} />
));
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex shrink-0 items-center justify-end gap-2 p-4 pt-2", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};

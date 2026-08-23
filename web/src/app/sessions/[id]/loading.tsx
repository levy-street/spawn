import { AppShell } from "@/components/nav/AppShell";
import { Spinner } from "@/components/ui/spinner";

/**
 * Shown the instant a session is opened full screen. The route's code, the
 * session record, and a fresh terminal connection all have to arrive before
 * the view can paint; without this the click looks ignored and the old page
 * just sits there.
 */
export default function LoadingSession() {
  return (
    <AppShell hideMobileNav mainClassName="overflow-hidden !pb-0">
      <div className="grid h-[calc(var(--vv-height)-2*var(--content-inset))] place-items-center bg-background">
        <Spinner label="Opening session" />
      </div>
    </AppShell>
  );
}

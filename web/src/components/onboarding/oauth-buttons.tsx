import { Button } from "@/components/ui/button";
import type { AuthProvider } from "@/lib/api";

/** Apple's mark, which its brand guidelines require alongside the wording. */
function AppleMark() {
  return (
    <svg
      aria-hidden="true"
      className="mr-2 h-4 w-4 fill-current"
      viewBox="0 0 24 24"
      focusable="false"
    >
      <path d="M17.05 12.53c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.19-1.72-1.36-.14-2.65.8-3.34.8-.69 0-1.75-.78-2.88-.76-1.48.02-2.85.86-3.61 2.18-1.54 2.67-.39 6.62 1.11 8.79.73 1.06 1.6 2.25 2.75 2.21 1.1-.05 1.52-.71 2.85-.71 1.33 0 1.71.71 2.88.69 1.19-.02 1.94-1.08 2.67-2.15.84-1.23 1.19-2.42 1.21-2.48-.03-.01-2.32-.89-2.33-3.54zM14.86 5.6c.6-.74 1.01-1.76.9-2.78-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.7-.92 2.7.97.08 1.97-.49 2.58-1.23z" />
    </svg>
  );
}

export function OAuthButtons({
  providers,
  returnTo,
  loading = false,
}: {
  providers: readonly AuthProvider[];
  returnTo: string;
  loading?: boolean;
}) {
  if (loading || providers.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {providers.map((provider) => (
          <Button
            key={provider.id}
            asChild
            variant="outline"
            className="h-11 w-full justify-center"
          >
            <a
              href={`/api/auth/oauth/${provider.id}/start?${new URLSearchParams({
                return_to: returnTo,
              })}`}
            >
              {provider.id === "apple" ? <AppleMark /> : null}
              {/* Apple's guidelines require this exact wording for its button;
                  every other provider takes the house phrasing. */}
              {provider.id === "apple" ? "Sign in with Apple" : `Continue with ${provider.name}`}
            </a>
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-3 font-sigil text-[10px] uppercase tracking-[0.22em] text-ash">
        <div className="h-px flex-1 bg-line-g" aria-hidden />
        <span>or use email</span>
        <div className="h-px flex-1 bg-line-g" aria-hidden />
      </div>
    </div>
  );
}

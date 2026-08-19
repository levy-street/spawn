import { Button } from "@/components/ui/button";
import type { AuthProvider } from "@/lib/api";

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
            variant="secondary"
            className="h-11 w-full justify-center"
          >
            <a
              href={`/api/auth/oauth/${provider.id}/start?${new URLSearchParams({
                return_to: returnTo,
              })}`}
            >
              Continue with {provider.name}
            </a>
          </Button>
        ))}
      </div>
      <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-muted-foreground">
        <div className="h-px flex-1 bg-border" aria-hidden />
        <span>or use email</span>
        <div className="h-px flex-1 bg-border" aria-hidden />
      </div>
    </div>
  );
}

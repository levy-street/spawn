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
            variant="outline"
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
      <div className="flex items-center gap-3 font-sigil text-[10px] uppercase tracking-[0.22em] text-ash">
        <div className="h-px flex-1 bg-line-g" aria-hidden />
        <span>or use email</span>
        <div className="h-px flex-1 bg-line-g" aria-hidden />
      </div>
    </div>
  );
}

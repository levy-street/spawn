"use client";

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { auth } from "@/lib/api";

interface SocialLoginButtonsProps {
  returnTo?: string;
}

export function SocialLoginButtons({ returnTo = "/" }: SocialLoginButtonsProps) {
  const providersQ = useQuery({
    queryKey: ["auth-providers"],
    queryFn: auth.providers,
    retry: false,
    staleTime: 60_000,
  });
  const providers = providersQ.data?.providers ?? [];
  if (providers.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {providers.map((provider) => (
          <Button key={provider.id} asChild variant="secondary" className="w-full justify-center">
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
      <div className="flex items-center gap-2 text-xs uppercase text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        <span>or use email</span>
        <div className="h-px flex-1 bg-border" />
      </div>
    </div>
  );
}

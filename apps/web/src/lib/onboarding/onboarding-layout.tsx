"use client";

import { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Moon, Sun, LogOut, Loader2 } from "lucide-react";
import { Button } from "@onecli/ui/components/button";
import { useAuth } from "@/providers/auth-provider";
import { CAPS } from "@/lib/env";
import {
  checkOnboardingComplete,
  getOnboardingProgress,
} from "@/lib/onboarding/actions";
import { getActiveWorkspacePath } from "@/lib/workspaces/actions";
import { OnboardingProvider } from "@/lib/onboarding/onboarding-context";
import {
  isStepAllowed,
  stepSlugFromPathname,
  type OnboardingProgress,
} from "@/lib/onboarding/steps";
import { FlowChrome } from "@/lib/onboarding/_components/flow-chrome";
import { OnboardingFooter } from "@/lib/onboarding/_components/onboarding-footer";
import { SkipIntroductionLink } from "@/lib/onboarding/_components/skip-introduction-link";

export default function OnboardingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const { signOut, isAuthenticated, isLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  // The completion bounce is decided once per hard mount, against the landing
  // path — in-session step navigation must never re-trigger it.
  const initialPathRef = useRef(pathname);
  const [signingOut, setSigningOut] = useState(false);
  const [boot, setBoot] = useState<OnboardingProgress | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace("/auth/login");
      return;
    }

    const bootFlow = async () => {
      // Onboarding is the billing editions' install walkthrough — nothing
      // routes here without billing, so a direct visit bounces home before
      // any billing action runs.
      if (!CAPS.billing) {
        router.replace(await getActiveWorkspacePath());
        return;
      }
      // Imported after the capability check so the billing actions (and the
      // Stripe graph behind them) never load in non-billing processes.
      const { getSubscriptionStatus } = await import("@/ee/billing/actions");
      const [{ status }, complete, path, progress] = await Promise.all([
        getSubscriptionStatus({ fallbackToDefault: true }),
        checkOnboardingComplete(),
        getActiveWorkspacePath(),
        getOnboardingProgress(),
      ]);
      // Completed users may stay only on a mid-flow step their saved progress
      // supports: fetching the install script marks onboarding complete
      // server-side, so a refresh on /coding-agent, /autonomous-agent or /run
      // (or on /agent after going back) must not eject them. Everything else
      // — the index, /welcome, or a step their progress can't reach — bounces
      // to the dashboard. Decided once per hard mount; in-session step
      // navigation never re-triggers it.
      const landingSlug = stepSlugFromPathname(initialPathRef.current);
      const completedMayStay =
        landingSlug !== null &&
        landingSlug !== "welcome" &&
        isStepAllowed(landingSlug, progress);
      if (status !== "free" || (complete && !completedMayStay)) {
        router.replace(path);
      } else {
        setBoot(progress);
      }
    };
    // Fail OPEN: a broken boot must never strand the user on the spinner.
    // The home page's own redirect resolves a working destination for any
    // member, so it is the safe harbor when a boot action rejects.
    bootFlow().catch(() => router.replace("/"));
  }, [isLoading, isAuthenticated, router]);

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut();
  };

  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex h-14 w-full max-w-5xl shrink-0 items-center justify-between border-b px-6">
        <Image
          src="/onecli-full-logo.png"
          alt="OneCLI"
          width={110}
          height={32}
          priority
          className="dark:hidden"
        />
        <Image
          src="/onecli-full-logo-dark.png"
          alt="OneCLI"
          width={110}
          height={32}
          priority
          className="hidden dark:block"
        />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() =>
              setTheme(resolvedTheme === "dark" ? "light" : "dark")
            }
          >
            <Sun className="size-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <Moon className="absolute size-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            <span className="sr-only">Toggle theme</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            disabled={signingOut}
          >
            {signingOut ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
            {signingOut ? "Signing out..." : "Sign out"}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-[4vh] pb-4 md:px-8">
        {boot ? (
          <OnboardingProvider initial={boot}>
            <FlowChrome>{children}</FlowChrome>
            <OnboardingFooter>
              <SkipIntroductionLink />
            </OnboardingFooter>
          </OnboardingProvider>
        ) : (
          <>
            <div className="flex items-center justify-center pt-[20vh]">
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            </div>
            <OnboardingFooter />
          </>
        )}
      </div>
    </div>
  );
}

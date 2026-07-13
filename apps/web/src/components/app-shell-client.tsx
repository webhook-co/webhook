"use client";

import { AppShell, IconButton } from "@webhook-co/ui";
import { Menu } from "lucide-react";
import * as React from "react";

// A thin client wrapper around AppShell that owns the mobile-drawer open state. AppShell already ships the
// focus-trapped drawer (below `md`) but is a controlled component — without this, the (app) layout (a server
// component, which can't hold useState) never opened it, so below `md` there was NO navigation at all. The
// hamburger lives in the top bar and is hidden at `md`+ where the fixed sidebar is always visible. The nav +
// account/theme controls are passed through as slots from the server layout (which keeps the session gate).
export function AppShellClient({
  homeHref,
  sidebar,
  sidebarTop,
  topBar,
  children,
}: {
  readonly homeHref?: string;
  readonly sidebar: React.ReactNode;
  /** Pinned above the nav — the org switcher. */
  readonly sidebarTop?: React.ReactNode;
  readonly topBar?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <AppShell
      homeHref={homeHref}
      sidebar={sidebar}
      sidebarTop={sidebarTop}
      sidebarOpen={open}
      onSidebarOpenChange={setOpen}
      topBar={
        <>
          <IconButton
            aria-label="Open navigation"
            variant="ghost"
            size="sm"
            className="md:hidden"
            onClick={() => setOpen(true)}
          >
            <Menu className="size-5" />
          </IconButton>
          {topBar}
        </>
      }
    >
      {children}
    </AppShell>
  );
}

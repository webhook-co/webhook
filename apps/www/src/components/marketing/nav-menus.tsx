"use client";

import { cn } from "@webhook-co/ui";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { PRODUCT_LINKS, RESOURCE_LINKS } from "@/components/marketing/nav-links";
import { focusRing } from "@/lib/styles";

interface MenuDef {
  id: string;
  label: string;
  links: readonly { label: string; href: string }[];
}

// Two menus: Product (what it does) and Resources (what you can use right now, without an account).
// Both point only at www pages, so the only nav item that leaves for docs.webhook.co is the top-level
// "Docs" link (see nav.tsx). The old "Developers" dropdown was a set of docs deep-links; those live in
// the footer, keeping the top nav to one door per destination.
//
// Resources was added because the tutorial estate and the sandbox were unreachable from the site's own
// chrome — see the note in `nav-links.ts`. It links the tutorial HUB, not individual providers.
//
// The links render in the SSR HTML (hidden), so they exist without JS and a crawler still sees them.
const MENUS: readonly MenuDef[] = [
  {
    id: "product",
    label: "Product",
    links: PRODUCT_LINKS,
  },
  {
    id: "resources",
    label: "Resources",
    links: RESOURCE_LINKS,
  },
];

/**
 * The Product nav dropdown — the one client island inside the otherwise server-rendered Nav. These
 * are *navigation links*, so they use the WAI-ARIA **disclosure** pattern (a button with
 * `aria-expanded` revealing a list of links), not the menu/menuitem roles. The trigger toggles on
 * click/Enter/Space; the menu closes on Escape (restoring focus to the trigger), an outside pointer
 * press, or focus leaving the menu. Only one is open at a time.
 */
export function NavMenus() {
  const [openId, setOpenId] = useState<string | null>(null);
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const wrappers = useRef<Record<string, HTMLDivElement | null>>({});

  // Escape closes the open menu and returns focus to its trigger.
  useEffect(() => {
    if (!openId) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const trigger = triggers.current[openId!];
        setOpenId(null);
        trigger?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [openId]);

  // A pointer press anywhere outside the open menu closes it.
  useEffect(() => {
    if (!openId) return;
    function onPointerDown(event: PointerEvent) {
      const wrapper = wrappers.current[openId!];
      if (wrapper && !wrapper.contains(event.target as Node)) setOpenId(null);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openId]);

  return (
    <div className="flex items-center gap-0.5">
      {MENUS.map((menu) => {
        const open = openId === menu.id;
        return (
          <div
            key={menu.id}
            ref={(el) => {
              wrappers.current[menu.id] = el;
            }}
            className="relative"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setOpenId((cur) => (cur === menu.id ? null : cur));
              }
            }}
          >
            <button
              ref={(el) => {
                triggers.current[menu.id] = el;
              }}
              type="button"
              aria-expanded={open}
              aria-controls={`navmenu-${menu.id}`}
              onClick={() => setOpenId(open ? null : menu.id)}
              className={cn(
                focusRing,
                "inline-flex h-[2.125rem] items-center gap-1 rounded-control px-3 text-sm text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
              )}
            >
              {menu.label}
              <ChevronDown
                size={14}
                aria-hidden="true"
                className={cn("text-fg-muted transition-transform", open && "rotate-180")}
              />
            </button>

            <div
              id={`navmenu-${menu.id}`}
              hidden={!open}
              className="absolute top-full left-0 z-50 pt-2"
            >
              <ul className="flex min-w-[220px] flex-col rounded-card border border-hairline bg-surface p-1.5 shadow-3">
                {menu.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className={cn(
                        focusRing,
                        "block rounded-control px-3 py-2 text-sm text-fg-secondary transition-colors hover:bg-surface-sunken hover:text-fg",
                      )}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}

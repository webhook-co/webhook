import * as React from "react";

import { cn } from "../lib/cn";

export interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  /**
   * Props for the scroll container that wraps the table. The wrapper is keyboard-scrollable
   * by default (`tabIndex={0}`); for a wide/overflow-prone table give it an accessible name
   * via `containerProps={{ role: "region", "aria-label": "…" }}`.
   */
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
}

/**
 * A composable data table — the structural primitives (`TableHeader`/`TableBody`/`TableRow`/
 * `TableHead`/`TableCell`), a `TableCaption`, and a `TableEmpty` convenience for the
 * empty state. Styling is token-only; the caller owns column content (e.g. mono ids via a
 * `className`). The table scrolls horizontally inside its wrapper on narrow viewports, and
 * the wrapper is keyboard-focusable so those columns stay reachable without a pointer.
 */
export const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, containerProps, ...props }, ref) => {
    const { className: containerClassName, ...restContainer } = containerProps ?? {};
    return (
      <div
        tabIndex={0}
        className={cn("relative w-full overflow-x-auto", containerClassName)}
        {...restContainer}
      >
        <table
          ref={ref}
          className={cn("w-full caption-bottom border-collapse text-sm", className)}
          {...props}
        />
      </div>
    );
  },
);
Table.displayName = "Table";

export const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <thead ref={ref} className={cn("border-b border-hairline", className)} {...props} />
));
TableHeader.displayName = "TableHeader";

export const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => <tbody ref={ref} className={cn(className)} {...props} />);
TableBody.displayName = "TableBody";

export const TableRow = React.forwardRef<
  HTMLTableRowElement,
  React.HTMLAttributes<HTMLTableRowElement>
>(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      "border-b border-hairline transition-colors last:border-0 hover:bg-surface-sunken",
      className,
    )}
    {...props}
  />
));
TableRow.displayName = "TableRow";

export const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-10 px-4 text-left align-middle font-mono text-xs font-medium uppercase tracking-mono-label text-fg-muted",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

export const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td ref={ref} className={cn("px-4 py-3 align-middle text-fg", className)} {...props} />
));
TableCell.displayName = "TableCell";

export const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-3 text-sm text-fg-muted", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

export interface TableEmptyProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** Number of columns to span so the message centers across the table. */
  colSpan?: number;
}

/** A full-width empty-state row for an otherwise empty `TableBody`. */
export const TableEmpty = React.forwardRef<HTMLTableCellElement, TableEmptyProps>(
  ({ className, children, ...props }, ref) => (
    <tr>
      <td
        ref={ref}
        className={cn("px-4 py-10 text-center text-sm text-fg-muted", className)}
        {...props}
      >
        {children}
      </td>
    </tr>
  ),
);
TableEmpty.displayName = "TableEmpty";

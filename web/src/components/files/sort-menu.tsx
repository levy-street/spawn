"use client";

import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { COLUMNS } from "@/lib/files/columns";
import { FOLDERS_ON_TOP_LABEL, SORT_ORDER_LABELS } from "@/lib/files/copy";
import { FIRST_ORDER, SORT_KEYS, type SortOrder, type SortSpec } from "@/lib/files/sort";

/**
 * The file browser's sort, as menu items: the field, its two directions in
 * the words that fit it, and folders on top. One set for every menu that
 * offers it — the page's View options, a workspace pane's Sort — so the
 * choices, their order and what each does cannot drift between them. The
 * phone's View options sheet offers the same three.
 */
export function SortMenuItems({
  sort,
  onSort,
}: {
  sort: SortSpec;
  onSort: (next: SortSpec) => void;
}) {
  const orders: SortOrder[] = FIRST_ORDER[sort.key] === "asc" ? ["asc", "desc"] : ["desc", "asc"];
  return (
    <>
      <DropdownMenuLabel>Sort by</DropdownMenuLabel>
      {SORT_KEYS.map((key) => (
        <DropdownMenuItem
          key={key}
          checked={sort.key === key}
          onSelect={() => sort.key !== key && onSort({ ...sort, key, order: FIRST_ORDER[key] })}
        >
          {COLUMNS.find((column) => column.key === key)?.label ?? key}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      {/* Worded for the field, its first-click direction first. */}
      {orders.map((order) => (
        <DropdownMenuItem
          key={order}
          checked={sort.order === order}
          onSelect={() => onSort({ ...sort, order })}
        >
          {SORT_ORDER_LABELS[sort.key][order]}
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem
        checked={sort.foldersFirst}
        onSelect={() => onSort({ ...sort, foldersFirst: !sort.foldersFirst })}
      >
        {FOLDERS_ON_TOP_LABEL}
      </DropdownMenuItem>
    </>
  );
}

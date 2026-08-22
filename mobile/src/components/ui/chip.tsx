import { Badge, type BadgeProps, type BadgeVariant } from "@/components/ui/badge";

export type ChipVariant = BadgeVariant;
export type ChipProps = BadgeProps;

export function Chip(props: ChipProps) {
  return <Badge {...props} />;
}

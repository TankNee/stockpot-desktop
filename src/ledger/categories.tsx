import {
  Banknote,
  BookOpen,
  Bus,
  Car,
  CircleEllipsis,
  Coffee,
  CreditCard,
  Fuel,
  Gift,
  HeartPulse,
  House,
  Lightbulb,
  Package,
  Phone,
  Plane,
  Popcorn,
  RefreshCcw,
  Salad,
  Shirt,
  ShoppingBasket,
  Smartphone,
  TrainFront,
  TrendingUp,
  UtensilsCrossed,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { CategoryDef } from "./types";

/** `group/leaf`, or just `name` for a top-level category. */
export function categoryPath(def: CategoryDef): string {
  return def.parent ? `${def.parent}/${def.name}` : def.name;
}

/** The group a path belongs to: "餐饮/咖啡" → "餐饮". */
export function topCategory(path: string): string {
  return path.split("/")[0];
}

/** Does an entry's category fall under this filter? A group matches its leaves. */
export function categoryMatches(entryCategory: string, filter: string): boolean {
  return entryCategory === filter || entryCategory.startsWith(`${filter}/`);
}

/** Icon key → glyph. Keys are deliberately generic ("food", "taxi") so a
 *  category can be re-pointed without renaming it. lucide-react already ships
 *  with the app: one consistent stroke weight, MIT licensed, no extra assets. */
const ICONS: Record<string, LucideIcon> = {
  food: UtensilsCrossed,
  coffee: Coffee,
  takeout: Package,
  salad: Salad,
  transport: TrainFront,
  bus: Bus,
  taxi: Car,
  fuel: Fuel,
  shopping: ShoppingBasket,
  basket: ShoppingBasket,
  shirt: Shirt,
  device: Smartphone,
  home: House,
  bolt: Lightbulb,
  fun: Popcorn,
  film: Popcorn,
  plane: Plane,
  health: HeartPulse,
  book: BookOpen,
  phone: Phone,
  gift: Gift,
  salary: Banknote,
  bonus: Gift,
  invest: TrendingUp,
  refund: RefreshCcw,
  transfer: CreditCard,
  wallet: Wallet,
  dots: CircleEllipsis,
};

export const CATEGORY_ICON_KEYS = Object.keys(ICONS);

export function CategoryIcon({
  icon,
  size = 12,
  className,
}: {
  icon: string;
  size?: number;
  className?: string;
}) {
  const Glyph = ICONS[icon] ?? CircleEllipsis;
  return <Glyph size={size} strokeWidth={2} className={className} />;
}

/** Categories in tree order: each group followed by its leaves. */
export function orderedCategories(categories: CategoryDef[]): CategoryDef[] {
  const groups = categories.filter((c) => !c.parent);
  const out: CategoryDef[] = [];
  for (const group of groups) {
    out.push(group);
    out.push(...categories.filter((c) => c.parent === group.name));
  }
  // Leaves whose group is gone still need to be reachable.
  out.push(...categories.filter((c) => c.parent && !groups.some((g) => g.name === c.parent)));
  return out;
}

/** A native select with one optgroup per top-level category. */
export function CategorySelect({
  categories,
  value,
  onChange,
  ariaLabel,
  className,
  kind,
  includeAll,
  allLabel,
}: {
  categories: CategoryDef[];
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
  /** Restrict to a direction when set. */
  kind?: "expense" | "income";
  includeAll?: boolean;
  allLabel?: string;
}) {
  const ordered = orderedCategories(categories).filter(
    (c) => !kind || !c.kind || c.kind === kind,
  );
  const groups = ordered.filter((c) => !c.parent);
  const loose = ordered.filter((c) => c.parent && !groups.some((g) => g.name === c.parent));

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={ariaLabel}
      className={cn(
        "h-[26px] rounded-[5px] border border-border bg-surface px-1.5 text-[12px]",
        className,
      )}
    >
      {includeAll ? <option value="all">{allLabel}</option> : null}
      {groups.map((group) => {
        const leaves = ordered.filter((c) => c.parent === group.name);
        return (
          <optgroup key={group.name} label={group.name}>
            <option value={group.name}>{group.name}</option>
            {leaves.map((leaf) => (
              <option key={categoryPath(leaf)} value={categoryPath(leaf)}>
                　{leaf.name}
              </option>
            ))}
          </optgroup>
        );
      })}
      {loose.map((leaf) => (
        <option key={categoryPath(leaf)} value={categoryPath(leaf)}>
          {categoryPath(leaf)}
        </option>
      ))}
    </select>
  );
}

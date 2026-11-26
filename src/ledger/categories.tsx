import * as React from "react";
import {
  Award,
  Baby,
  Banknote,
  Bike,
  BookOpen,
  Bus,
  Car,
  ChevronDown,
  CircleEllipsis,
  CircleParking,
  Clapperboard,
  Coffee,
  Cookie,
  CreditCard,
  Dumbbell,
  Fuel,
  Gamepad2,
  Gift,
  GraduationCap,
  HandCoins,
  HeartPulse,
  House,
  KeyRound,
  Package,
  PawPrint,
  Phone,
  Pill,
  Plane,
  Popcorn,
  RefreshCcw,
  Salad,
  Shirt,
  ShoppingBasket,
  ShoppingCart,
  Smartphone,
  Sparkles,
  TrainFront,
  TrendingUp,
  UtensilsCrossed,
  Wallet,
  Wifi,
  Wine,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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

/** 图标 key → 字形。key 故意取通用的词（"food"、"taxi"），分类改名不用动图标。
 *
 *  风格上只用 lucide 的单线条描边：24 网格、圆头圆角、恒定线宽，和界面里其它
 *  图标（lucide 全套）是同一只手画的。选择器里按用途分组，标签走 i18n。 */
const ICONS: Record<string, LucideIcon> = {
  // 吃
  food: UtensilsCrossed,
  coffee: Coffee,
  takeout: Package,
  snack: Cookie,
  drink: Wine,
  salad: Salad,
  // 行
  transport: TrainFront,
  bus: Bus,
  taxi: Car,
  fuel: Fuel,
  parking: CircleParking,
  bike: Bike,
  // 买
  shopping: ShoppingBasket,
  basket: ShoppingCart,
  shirt: Shirt,
  device: Smartphone,
  beauty: Sparkles,
  // 住
  home: House,
  rent: KeyRound,
  bolt: Zap,
  repair: Wrench,
  // 生活
  fun: Popcorn,
  film: Clapperboard,
  game: Gamepad2,
  travel: Plane,
  pet: PawPrint,
  kid: Baby,
  // 健康
  health: HeartPulse,
  pill: Pill,
  gym: Dumbbell,
  // 成长
  book: BookOpen,
  school: GraduationCap,
  // 通讯
  phone: Phone,
  net: Wifi,
  // 人情
  gift: Gift,
  redpacket: HandCoins,
  // 钱
  salary: Banknote,
  bonus: Award,
  invest: TrendingUp,
  refund: RefreshCcw,
  transfer: CreditCard,
  wallet: Wallet,
  // 兜底
  dots: CircleEllipsis,
};

export const CATEGORY_ICON_KEYS = Object.keys(ICONS);

/** 分类名 → 图标。用户没挑的时候按名字猜一个，界面才不至于满屏「其他」。
 *  和手机端 `builtinIcon()` 是同一张表，同一个分类两端长得一样。 */
const NAME_ICONS: [string[], string][] = [
  [["餐饮", "吃喝", "早餐", "午餐", "晚餐", "夜宵", "食堂"], "food"],
  [["咖啡", "奶茶"], "coffee"],
  [["外卖"], "takeout"],
  [["零食"], "snack"],
  [["酒", "酒水"], "drink"],
  [["轻食", "沙拉"], "salad"],
  [["交通", "出行"], "transport"],
  [["地铁", "地铁公交", "公交"], "bus"],
  [["打车", "出租车", "网约车"], "taxi"],
  [["加油", "油费"], "fuel"],
  [["停车"], "parking"],
  [["骑行", "自行车"], "bike"],
  [["购物", "买"], "shopping"],
  [["日用", "日用品"], "basket"],
  [["服饰", "衣服"], "shirt"],
  [["数码", "电子"], "device"],
  [["美妆", "化妆"], "beauty"],
  [["居住", "住"], "home"],
  [["房租", "房贷"], "rent"],
  [["水电", "水电燃气", "电费", "水费", "燃气"], "bolt"],
  [["维修", "修理"], "repair"],
  [["娱乐", "休闲"], "fun"],
  [["电影"], "film"],
  [["游戏"], "game"],
  [["旅行", "旅游"], "travel"],
  [["宠物"], "pet"],
  [["孩子", "育儿"], "kid"],
  [["医疗", "健康"], "health"],
  [["药品", "药"], "pill"],
  [["健身", "运动"], "gym"],
  [["教育", "学习", "成长"], "book"],
  [["学费", "培训"], "school"],
  [["通讯"], "phone"],
  [["网络", "宽带"], "net"],
  [["人情", "社交"], "gift"],
  [["红包"], "redpacket"],
  [["工资", "收入"], "salary"],
  [["奖金", "年终奖"], "bonus"],
  [["理财", "投资"], "invest"],
  [["退款"], "refund"],
  [["转账"], "transfer"],
  [["其他"], "dots"],
];

export function guessCategoryIcon(name: string): string {
  const leaf = name.split("/").pop() ?? name;
  for (const [names, key] of NAME_ICONS) {
    if (names.includes(leaf)) return key;
  }
  // 英文/自定义名字不猜，交给兜底
  return "";
}

/** 一条分类实际该画哪个图标：自己配了就用，没配按名字猜。 */
export function categoryIconKey(def: Pick<CategoryDef, "name" | "icon">): string {
  return def.icon || guessCategoryIcon(def.name);
}

/** 面板里一行放几个。43 个图标正好 5 行，一屏看得完，不用翻。 */
const PICKER_COLUMNS = 9;

/** 小尺寸下 2px 的线会糊成一团，统一收到 1.8。 */
const STROKE = 1.8;

export function CategoryIcon({
  icon,
  size = 12,
  className,
  strokeWidth = STROKE,
}: {
  icon: string;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  const Glyph = ICONS[icon] ?? CircleEllipsis;
  return <Glyph size={size} strokeWidth={strokeWidth} className={className} />;
}

/**
 * 选图标：按钮上显示当前那个，点开是一个弹层网格。
 *
 * 不用行内展开：43 个图标铺开会把下面的分类列表顶出一屏，而且设置页本身
 * 可滚动，绝对定位的浮层又会被裁掉。弹层两头都躲开了。
 */
export function CategoryIconPicker({
  value,
  onChange,
  t,
}: {
  value: string;
  onChange: (key: string) => void;
  /** 传进来而不是在这里 useStore，免得 categories 和 store 互相 import。 */
  t: (key: string) => string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = value || "dots";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("ledger.categories.icon")}
        className="flex h-[27px] items-center gap-1.5 rounded-[5px] border border-border bg-surface px-1.5 text-[12px] transition-colors hover:border-hairline"
      >
        <CategoryIcon icon={current} size={14} />
        <span className="max-w-[72px] truncate">{t(`ledger.icon.${current}`)}</span>
        <ChevronDown size={11} strokeWidth={2} className="text-faint" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(524px,calc(100vw-48px))] p-0">
          <DialogTitle className="border-b border-hairline/60 px-3.5 py-2.5 text-[12.5px] font-medium">
            {t("ledger.categories.pickIcon")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("ledger.categories.iconHint")}
          </DialogDescription>
          <div
            className="grid gap-1 p-2.5"
            style={{ gridTemplateColumns: `repeat(${PICKER_COLUMNS}, minmax(0, 1fr))` }}
          >
            {CATEGORY_ICON_KEYS.map((key) => {
              const active = key === current;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    onChange(key);
                    setOpen(false);
                  }}
                  title={t(`ledger.icon.${key}`)}
                  aria-pressed={active}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-[5px] border px-0.5 py-1.5 transition-colors",
                    active
                      ? "border-accent/60 bg-accent-soft text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-surface hover:text-foreground",
                  )}
                >
                  <CategoryIcon icon={key} size={17} />
                  <span className="w-full truncate text-center text-[9.5px] leading-none">
                    {t(`ledger.icon.${key}`)}
                  </span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
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

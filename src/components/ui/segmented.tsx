import { useRef } from "react";
import { cn } from "@/lib/utils";

interface Option<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/** A segmented control for two to four short choices. It is a real ARIA radio
 *  group: one tab stop, arrow keys move and select, Home/End jump to the ends. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  ariaLabel,
  size = "md",
}: {
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
  className?: string;
  ariaLabel: string;
  size?: "sm" | "md";
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "inline-grid w-full auto-cols-fr grid-flow-col gap-[2px] rounded-[6px] border border-hairline bg-surface p-[2px]",
        className,
      )}
      onKeyDown={(event) => {
        const index = options.findIndex((option) => option.value === value);
        const current = index < 0 ? 0 : index;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          move(current, 1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          move(current, -1);
        } else if (event.key === "Home") {
          event.preventDefault();
          onChange(options[0].value);
          refs.current[0]?.focus();
        } else if (event.key === "End") {
          event.preventDefault();
          const last = options.length - 1;
          onChange(options[last].value);
          refs.current[last]?.focus();
        }
      }}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={option.hint}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative flex items-center justify-center rounded-[4px] font-medium transition-colors duration-150",
              size === "sm" ? "h-[20px] px-1.5 text-[10.5px]" : "h-[24px] px-2 text-[11.5px]",
              active
                ? "bg-panel text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.14),0_1px_0_oklch(1_0_0/0.5)_inset] dark:shadow-[0_1px_2px_oklch(0_0_0/0.4)]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

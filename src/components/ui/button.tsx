import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] text-[12px] font-medium transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-45 select-none [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "bg-accent-strong text-[var(--paper)] shadow-[0_1px_0_oklch(1_0_0/0.18)_inset,0_1px_2px_oklch(0_0_0/0.14)] hover:brightness-[1.1] active:brightness-[0.95]",
        secondary:
          "border border-border bg-surface text-foreground hover:bg-surface-strong active:bg-surface-strong",
        ghost:
          "text-muted-foreground hover:bg-surface hover:text-foreground active:bg-surface-strong",
        quiet:
          "text-muted-foreground hover:text-foreground",
        danger:
          "border border-transparent text-[color:var(--red)] hover:bg-[color-mix(in_oklch,var(--red)_11%,transparent)]",
        outline:
          "border border-hairline bg-transparent text-foreground hover:border-accent hover:text-accent",
      },
      size: {
        sm: "h-6 px-2 text-[11px]",
        md: "h-7 px-2.5",
        lg: "h-8 px-3",
        icon: "size-7 p-0",
        "icon-sm": "size-6 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };

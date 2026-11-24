import * as React from "react";
import { cn } from "@/lib/utils";

/** Native input on purpose: a text field with a visible caret rule reads as a
 *  ledger entry, and the webview already provides native selection for CJK. */
function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "h-7 w-full min-w-0 rounded-[5px] border border-hairline bg-panel px-2 text-[12px] text-foreground",
        "placeholder:text-faint",
        "transition-colors duration-150 hover:border-[color-mix(in_oklch,var(--hairline)_60%,var(--foreground))]",
        "focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-[color-mix(in_oklch,var(--accent)_45%,transparent)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };

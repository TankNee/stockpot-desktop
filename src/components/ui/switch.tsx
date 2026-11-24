import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[16px] w-[28px] shrink-0 cursor-pointer items-center rounded-full border transition-colors duration-150",
        "border-hairline bg-surface-strong data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        "disabled:cursor-not-allowed disabled:opacity-45",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-[12px] translate-x-[2px] rounded-full bg-panel shadow-[0_1px_2px_oklch(0_0_0/0.3)] transition-transform duration-150",
          "data-[state=checked]:translate-x-[13px] data-[state=checked]:bg-white",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };

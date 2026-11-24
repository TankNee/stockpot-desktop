import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "text-[10.5px] font-medium uppercase tracking-[0.09em] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Label };

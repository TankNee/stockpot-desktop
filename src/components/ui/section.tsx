import * as React from "react";
import { cn } from "@/lib/utils";

/** Settings are grouped under small caps labels separated by a hairline, the
 *  way a printed form separates its blocks. */
export function Section({
  title,
  hint,
  children,
  className,
  action,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {action}
      </div>
      {hint ? <p className="-mt-1 text-[10.5px] leading-snug text-faint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function FieldRow({
  label,
  children,
  hint,
  htmlFor,
}: {
  label: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label
          htmlFor={htmlFor}
          className="text-[11px] font-medium tracking-[0.01em] text-foreground"
        >
          {label}
        </label>
        {hint ? <span className="text-[10px] text-faint">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

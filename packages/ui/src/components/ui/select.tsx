import * as SelectPrimitive from "@radix-ui/react-select";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { Icon, icons } from "../../icons";
import { cn } from "../../lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const triggerVariants = cva(
  "flex w-fit cursor-pointer items-center justify-between gap-2 rounded-md text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [&>span]:min-w-0 [&>span]:truncate",
  {
    variants: {
      variant: {
        /** A form field: bordered box matching Input and Button. */
        field: "h-8 border border-input bg-card px-2.5 text-foreground",
        /** A quiet picker in a toolbar (the composer's agent/model/effort). */
        ghost:
          "h-7 max-w-[180px] border-0 bg-transparent px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground focus:bg-muted focus:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground",
      },
    },
    defaultVariants: { variant: "field" },
  },
);

export function SelectTrigger({
  className,
  variant,
  children,
  ...props
}: ComponentProps<typeof SelectPrimitive.Trigger> & VariantProps<typeof triggerVariants>) {
  return (
    <SelectPrimitive.Trigger className={cn(triggerVariants({ variant }), className)} {...props}>
      {children}
      <SelectPrimitive.Icon asChild>
        <Icon className="size-3.5 shrink-0 text-faint">{icons.chevronDown}</Icon>
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** The dropdown list. Popper positioning keeps it beside the trigger, flipping at the edge. */
export function SelectContent({
  className,
  children,
  position = "popper",
  sideOffset = 4,
  ...props
}: ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        position={position}
        sideOffset={sideOffset}
        className={cn(
          "relative z-50 max-h-[min(18rem,var(--radix-select-content-available-height))] min-w-32 animate-pop overflow-hidden rounded-lg border border-input bg-popover text-foreground shadow-pop",
          position === "popper" &&
            "data-[side=bottom]:translate-y-0.5 data-[side=left]:-translate-x-0.5 data-[side=right]:translate-x-0.5 data-[side=top]:-translate-y-0.5",
          className,
        )}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn("p-1", position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)]")}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectLabel({ className, ...props }: ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn("px-2.5 py-1.5 text-xs font-medium text-faint", className)} {...props} />;
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex h-8 w-full cursor-default items-center rounded-md py-1.5 pl-2.5 pr-7 text-[13px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-sunken data-[highlighted]:text-foreground",
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-4 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Icon className="size-3.5">{icons.check}</Icon>
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText className="truncate">{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

export function SelectSeparator({ className, ...props }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn("mx-1 my-1 h-px bg-border", className)} {...props} />;
}

function SelectScrollUpButton({ className, ...props }: ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton className={cn("flex items-center justify-center py-1", className)} {...props}>
      <Icon className="size-3.5">{icons.chevronUp}</Icon>
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({ className, ...props }: ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton className={cn("flex items-center justify-center py-1", className)} {...props}>
      <Icon className="size-3.5">{icons.chevronDown}</Icon>
    </SelectPrimitive.ScrollDownButton>
  );
}

export { Select, SelectGroup, SelectValue };

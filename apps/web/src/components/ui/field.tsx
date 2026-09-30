import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function FieldGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-group"
      className={cn('flex flex-col gap-4', className)}
      {...props}
    />
  );
}
export function Field({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="field"
      className={cn(
        'group/field flex min-w-0 flex-col gap-2 data-[invalid=true]:text-destructive',
        className,
      )}
      {...props}
    />
  );
}
export function FieldLabel({ className, ...props }: ComponentProps<'label'>) {
  return (
    <label
      data-slot="field-label"
      className={cn('text-sm font-medium', className)}
      {...props}
    />
  );
}
export function FieldDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="field-description"
      className={cn(
        'text-xs leading-relaxed text-muted-foreground group-data-[invalid=true]/field:text-destructive',
        className,
      )}
      {...props}
    />
  );
}

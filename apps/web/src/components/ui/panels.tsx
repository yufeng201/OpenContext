import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      data-slot="card"
      className={cn(
        'min-w-0 rounded-xl border border-border bg-card text-card-foreground shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn('flex flex-col gap-1.5 p-5', className)}
      {...props}
    />
  );
}
export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      data-slot="card-title"
      className={cn('font-semibold tracking-tight', className)}
      {...props}
    />
  );
}
export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="card-description"
      className={cn('text-sm leading-relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}
export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-content"
      className={cn('px-5 pb-5', className)}
      {...props}
    />
  );
}
export function Badge({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex shrink-0 items-center rounded border border-border bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground',
        className,
      )}
      {...props}
    />
  );
}
export function Alert({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(
        'rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive',
        className,
      )}
      {...props}
    />
  );
}
export function Empty({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty"
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

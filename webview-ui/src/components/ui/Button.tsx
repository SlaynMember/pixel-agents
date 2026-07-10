import type { ButtonHTMLAttributes } from 'react';

const base = 'border-2 rounded-none cursor-pointer';

const sizes = {
  xs: 'py-1 px-4 text-2xs',
  sm: 'py-1 px-8 text-sm',
  md: 'py-2 px-12',
  lg: 'py-3 px-14 text-lg',
  xl: 'py-6 px-24 text-xl',
  icon: 'p-0 w-16 h-16 flex items-center justify-center',
  icon_sm: 'p-0 w-28 h-28 flex items-center justify-center',
  icon_lg: 'p-0 w-40 h-40 flex items-center justify-center',
} as const;

const variants = {
  default: `${base} bg-btn-bg border-transparent hover:bg-btn-hover focus-visible:bg-btn-hover`,
  active: `${base} bg-active-bg border-accent hover:bg-active-bg focus-visible:bg-active-bg`,
  disabled: `${base} bg-btn-bg border-transparent cursor-default opacity-[var(--btn-disabled-opacity)]`,
  accent: `${base} bg-accent! hover:bg-accent-bright! focus-visible:bg-accent-bright! border-accent hover:border-accent-bright`,
  ghost: `${base} bg-transparent text-text-muted border-transparent hover:text-text`,
} as const;

type ButtonVariant = keyof typeof variants;
type ButtonSize = keyof typeof sizes;

// Translucent background layered on top of a variant when `translucent` is
// set — opt-in, used only by chrome that floats over the office canvas
// (BottomToolbar, ZoomControls, EditActionBar) so office tiles stay visible
// underneath. Hover/focus-visible restate the variant's already-opaque hover
// color; the `!` suffix forces the override since Tailwind's utility
// registration order isn't guaranteed to follow className source order.
const translucentOverrides: Record<ButtonVariant, string> = {
  default: 'bg-btn-bg-translucent! hover:bg-btn-hover! focus-visible:bg-btn-hover!',
  active: 'bg-active-bg-translucent! hover:bg-active-bg! focus-visible:bg-active-bg!',
  disabled: 'bg-btn-bg-translucent!',
  accent: 'bg-accent-translucent! hover:bg-accent-bright! focus-visible:bg-accent-bright!',
  ghost: '',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Translucent background for chrome floating over the office canvas; goes opaque on hover/focus. */
  translucent?: boolean;
}

export function Button({
  variant = 'default',
  size = 'lg',
  translucent = false,
  className = '',
  ...props
}: ButtonProps) {
  return (
    <button
      className={`${variants[variant]} ${sizes[size]} ${translucent ? translucentOverrides[variant] : ''} ${className}`}
      {...props}
    />
  );
}

'use client'

/**
 * Sliding on/off switch with an inline label. A small reusable primitive for
 * the boolean controls that previously inlined identical `role="switch"`
 * markup (the agent editor's Enabled / Boostable toggles). Visuals are frozen
 * to match those call sites — do not restyle without updating every consumer.
 */
export function ToggleSwitch({
  checked,
  onChange,
  label,
  disabled,
  title,
  className,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-2 cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed${className ? ` ${className}` : ''}`}
    >
      <div className={`relative w-9 h-5 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-bg-tertiary border border-border'}`}>
        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all duration-150 ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </div>
      <span className="text-xs text-text-secondary font-medium">{label}</span>
    </button>
  )
}

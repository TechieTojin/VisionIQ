import { useId, useRef } from 'react'

/**
 * Keyboard-complete selection controls.
 *
 * Both follow the WAI-ARIA patterns: a single tab stop, arrow keys to move,
 * Home/End to jump. They are used across every page, so getting the keyboard
 * model right once matters more than in any one screen.
 */

function moveFocus(
  event: React.KeyboardEvent,
  index: number,
  count: number,
  select: (i: number) => void,
): void {
  let next: number
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = (index + 1) % count
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      next = (index - 1 + count) % count
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = count - 1
      break
    default:
      return
  }
  event.preventDefault()
  select(next)
}

export interface Option<T extends string> {
  value: T
  label: string
}

/** A radio group drawn as a segmented button bar. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  size = 'md',
}: {
  label: string
  options: readonly Option<T>[]
  value: T
  onChange: (value: T) => void
  size?: 'sm' | 'md'
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const active = Math.max(0, options.findIndex((o) => o.value === value))

  return (
    <div className={`segmented segmented--${size}`} role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        <button
          key={option.value}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={i === active}
          tabIndex={i === active ? 0 : -1}
          className={`segmented__item${i === active ? ' is-active' : ''}`}
          onClick={() => onChange(option.value)}
          onKeyDown={(e) =>
            moveFocus(e, i, options.length, (n) => {
              onChange(options[n].value)
              refs.current[n]?.focus()
            })
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export interface TabSpec<T extends string> {
  value: T
  label: string
  badge?: string | number
}

/** ARIA tabs. Panels are rendered by the caller via `renderPanel`. */
export function Tabs<T extends string>({
  label,
  tabs,
  value,
  onChange,
  children,
}: {
  label: string
  tabs: readonly TabSpec<T>[]
  value: T
  onChange: (value: T) => void
  children: React.ReactNode
}) {
  const base = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const active = Math.max(0, tabs.findIndex((t) => t.value === value))

  return (
    <div className="tabs">
      <div className="tabs__list" role="tablist" aria-label={label}>
        {tabs.map((tab, i) => (
          <button
            key={tab.value}
            ref={(el) => {
              refs.current[i] = el
            }}
            id={`${base}-tab-${tab.value}`}
            type="button"
            role="tab"
            aria-selected={i === active}
            aria-controls={`${base}-panel`}
            tabIndex={i === active ? 0 : -1}
            className={`tabs__tab${i === active ? ' is-active' : ''}`}
            onClick={() => onChange(tab.value)}
            onKeyDown={(e) =>
              moveFocus(e, i, tabs.length, (n) => {
                onChange(tabs[n].value)
                refs.current[n]?.focus()
              })
            }
          >
            {tab.label}
            {tab.badge !== undefined && <span className="tabs__badge">{tab.badge}</span>}
          </button>
        ))}
      </div>
      <div
        id={`${base}-panel`}
        role="tabpanel"
        aria-labelledby={`${base}-tab-${tabs[active]?.value}`}
        className="tabs__panel"
        tabIndex={0}
      >
        {children}
      </div>
    </div>
  )
}

/** A labelled on/off switch backed by a real checkbox. */
export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  hint?: string
}) {
  return (
    <label className={`toggle${disabled ? ' is-disabled' : ''}`} title={hint}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
      <span className="toggle__label">{label}</span>
    </label>
  )
}

import { useEffect, useState } from 'react'

export type ChatPrototypeVariant = 'A' | 'B' | 'C'

const variants: Array<{ key: ChatPrototypeVariant; name: string }> = [
  { key: 'A', name: 'Conversation' },
  { key: 'B', name: 'Worklog' },
  { key: 'C', name: 'Focus' }
]

function readVariant(): ChatPrototypeVariant {
  const value = new URLSearchParams(window.location.search).get('variant')
  return value === 'B' || value === 'C' ? value : 'A'
}

function writeVariant(variant: ChatPrototypeVariant): void {
  const url = new URL(window.location.href)
  url.searchParams.set('variant', variant)
  window.history.replaceState(null, '', url)
  window.dispatchEvent(new Event('prototype-variant-change'))
}

export function useChatPrototypeVariant(): ChatPrototypeVariant {
  const [variant, setVariant] = useState(readVariant)
  useEffect(() => {
    const update = (): void => setVariant(readVariant())
    window.addEventListener('popstate', update)
    window.addEventListener('prototype-variant-change', update)
    return () => {
      window.removeEventListener('popstate', update)
      window.removeEventListener('prototype-variant-change', update)
    }
  }, [])
  return variant
}

export default function PrototypeSwitcher(): JSX.Element | null {
  const current = useChatPrototypeVariant()
  const index = variants.findIndex((variant) => variant.key === current)

  const cycle = (direction: -1 | 1): void => {
    const next = (index + direction + variants.length) % variants.length
    writeVariant(variants[next].key)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, [contenteditable="true"]')) return
      if (event.key === 'ArrowLeft') cycle(-1)
      if (event.key === 'ArrowRight') cycle(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (!import.meta.env.DEV) return null
  return (
    <nav className="prototype-switcher" aria-label="Chat node prototype variants">
      <button type="button" onClick={() => cycle(-1)} aria-label="Previous variant">{'<'}</button>
      <span><small>PROTOTYPE</small>{current} - {variants[index].name}</span>
      <button type="button" onClick={() => cycle(1)} aria-label="Next variant">{'>'}</button>
    </nav>
  )
}

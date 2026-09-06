import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { AppUpdateChip } from '../src/renderer/src/AppUpdateChip'
import { useAppUpdate } from '../src/renderer/src/use-app-update'
import type { AppUpdateSnapshot, AppUpdateStatus } from '../src/shared/app-update'

/**
 * The header's whole update surface: it says which version is running, it is how a user asks for a
 * check, and it turns into the restart offer once a package is waiting. It never interrupts.
 */

function renderChip(
  status: AppUpdateStatus,
  overrides: { announceError?: boolean; busy?: boolean; onCheck?: () => void; onRestart?: () => void } = {}
): { onCheck: () => void; onRestart: () => void } {
  const onCheck = overrides.onCheck ?? vi.fn()
  const onRestart = overrides.onRestart ?? vi.fn()
  render(
    <AppUpdateChip
      snapshot={{ currentVersion: '0.2.0', status }}
      announceError={overrides.announceError ?? false}
      busy={overrides.busy ?? false}
      onCheck={onCheck}
      onRestart={onRestart}
    />
  )
  return { onCheck, onRestart }
}

describe('the version chip', () => {
  test('shows the running version and checks for updates when clicked', () => {
    const { onCheck } = renderChip({ phase: 'idle' })
    const chip = screen.getByRole('button', { name: /0\.2\.0/ })
    expect(chip).toHaveAttribute('title', expect.stringContaining('Check for updates'))
    fireEvent.click(chip)
    expect(onCheck).toHaveBeenCalledTimes(1)
  })

  test('a check in flight says so and cannot be started twice', () => {
    const { onCheck } = renderChip({ phase: 'checking' }, { busy: true })
    const chip = screen.getByRole('button')
    expect(chip).toBeDisabled()
    fireEvent.click(chip)
    expect(onCheck).not.toHaveBeenCalled()
  })

  test('being on the latest version is an answer the chip gives, not a banner', () => {
    renderChip({ phase: 'up-to-date' })
    expect(screen.getByRole('button')).toHaveAttribute('title', expect.stringContaining('latest version'))
    expect(screen.queryByText(/Restart/)).toBeNull()
  })
})

describe('a downloaded package', () => {
  test('offers a restart that names the version and installs only when clicked', () => {
    const { onRestart, onCheck } = renderChip({ phase: 'downloaded', version: '0.3.0' })
    const restart = screen.getByRole('button', { name: 'Restart to update' })
    expect(restart).toHaveAttribute('title', expect.stringContaining('0.3.0'))
    fireEvent.click(restart)
    expect(onRestart).toHaveBeenCalledTimes(1)
    expect(onCheck).not.toHaveBeenCalled()
  })

  test('is an offer, not an interruption: no dialog takes the canvas', () => {
    renderChip({ phase: 'downloaded', version: '0.3.0' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })
})

describe('failures', () => {
  test('a background check that failed stays out of the interface', () => {
    renderChip({ phase: 'error', message: 'getaddrinfo ENOTFOUND github.com' })
    expect(screen.queryByText(/ENOTFOUND/)).toBeNull()
    expect(screen.getByRole('button')).toHaveTextContent('0.2.0')
  })

  test('a check the user asked for reports back, because otherwise the click did nothing', () => {
    renderChip({ phase: 'error', message: 'getaddrinfo ENOTFOUND github.com' }, { announceError: true })
    expect(screen.getByRole('button')).toHaveAttribute('title', expect.stringContaining('ENOTFOUND'))
    expect(screen.getByRole('button')).toHaveAttribute('data-phase', 'error')
  })
})

test('nothing is rendered before the host has answered', () => {
  const { container } = render(
    <AppUpdateChip snapshot={null} announceError={false} busy={false} onCheck={vi.fn()} onRestart={vi.fn()} />
  )
  expect(container).toBeEmptyDOMElement()
})

describe('the header wired to the host', () => {
  function installUpdateApi(): {
    publish: (snapshot: AppUpdateSnapshot) => void
    check: ReturnType<typeof vi.fn>
    restart: ReturnType<typeof vi.fn>
  } {
    let publish: (snapshot: AppUpdateSnapshot) => void = () => {}
    const api = {
      state: vi.fn(async () => ({ currentVersion: '0.2.0', status: { phase: 'idle' as const } })),
      check: vi.fn(async () => ({ currentVersion: '0.2.0', status: { phase: 'error' as const, message: 'offline' } })),
      restart: vi.fn(async () => true),
      onChange: (callback: (snapshot: AppUpdateSnapshot) => void) => {
        publish = callback
        return () => {}
      }
    }
    Object.defineProperty(window, 'appUpdateApi', { value: api, configurable: true, writable: true })
    return { publish: (snapshot) => publish(snapshot), check: api.check, restart: api.restart }
  }

  function Header(): JSX.Element {
    const update = useAppUpdate()
    return (
      <AppUpdateChip
        snapshot={update.snapshot}
        announceError={update.announceError}
        busy={update.busy}
        onCheck={update.check}
        onRestart={update.restart}
      />
    )
  }

  test('shows the host version, then the restart offer a download pushes, and restarts on click', async () => {
    const api = installUpdateApi()
    render(<Header />)

    const chip = await screen.findByRole('button', { name: /0\.2\.0/ })
    expect(chip).toBeInTheDocument()
    act(() => api.publish({ currentVersion: '0.2.0', status: { phase: 'downloaded', version: '0.3.0' } }))

    const restart = screen.getByRole('button', { name: 'Restart to update' })
    fireEvent.click(restart)
    expect(api.restart).toHaveBeenCalledTimes(1)
  })

  test('a failure is silent until the user asks, then it is reported', async () => {
    const api = installUpdateApi()
    render(<Header />)
    await screen.findByRole('button', { name: /0\.2\.0/ })

    // The startup check failed without anyone asking: the header must not mention it.
    act(() => api.publish({ currentVersion: '0.2.0', status: { phase: 'error', message: 'offline' } }))
    expect(screen.getByRole('button')).toHaveAttribute('data-phase', 'idle')

    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button')).toHaveAttribute('data-phase', 'error'))
    expect(api.check).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button')).toHaveAttribute('title', expect.stringContaining('offline'))
  })
  test('a reported failure is retired by the next background event, not left shouting', async () => {
    const api = installUpdateApi()
    render(<Header />)
    await screen.findByRole('button', { name: /0.2.0/ })

    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(screen.getByRole('button')).toHaveAttribute('data-phase', 'error'))

    // The next startup-style failure was nobody’s request, so it goes quiet again rather than
    // inheriting the visibility of the one check the user did ask for.
    act(() => api.publish({ currentVersion: '0.2.0', status: { phase: 'error', message: 'offline' } }))
    expect(screen.getByRole('button')).toHaveAttribute('data-phase', 'idle')
  })
})

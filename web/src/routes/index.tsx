import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { FormEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

type Search = { homeId?: string }

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): Search => ({
    homeId: typeof search.homeId === 'string' && search.homeId !== '' ? search.homeId : undefined,
  }),
  component: Page,
})

// ---------- types ----------

type Share = {
  id: string
  memberId: string
  memberName: string
  amountCents: number
  paidAt: string | null
}
type Bill = {
  id: string
  title: string
  totalCents: number
  shares: Share[]
}
type Balance = { memberId: string; name: string; outstandingCents: number }

// ---------- api helper ----------

class ApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function isErrorBody(value: unknown): value is { error: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof value.error === 'string'
  )
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    // A slow server must not leave the page waiting forever.
    res = await fetch(path, { ...init, signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new ApiError('Could not reach the server in time. Try again.', 0)
  }

  const text = await res.text()
  let data: unknown = null
  try {
    data = JSON.parse(text)
  } catch {
    data = null
  }

  if (!res.ok) {
    const message = isErrorBody(data) ? data.error : `Request failed (${res.status})`
    throw new ApiError(message, res.status)
  }
  return data as T
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong'
}

// Integer math only, so no decimal money.
function money(cents: number): string {
  const whole = Math.floor(cents / 100)
  const rest = String(cents % 100).padStart(2, '0')
  return `$${whole}.${rest}`
}

// ---------- page ----------

function Page() {
  const { homeId } = Route.useSearch()
  const navigate = useNavigate()

  return (
    <main
      style={{
        maxWidth: 640,
        margin: '0 auto',
        padding: 24,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1>Bill Splitter</h1>
      {homeId ? (
        <>
          <button type="button" onClick={() => void navigate({ to: '/', search: {} })}>
            Use a different home
          </button>
          <HomeView key={homeId} homeId={homeId} />
        </>
      ) : (
        <CreateHome />
      )}
    </main>
  )
}

function CreateHome() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const home = await api<{ id: string; name: string }>('/api/homes', jsonPost({ name }))
      await navigate({ to: '/', search: { homeId: home.id } })
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <h2>Create a home</h2>
      <label>
        Home name <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>{' '}
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create'}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

function HomeView({ homeId }: { homeId: string }) {
  const [bills, setBills] = useState<Bill[] | null>(null)
  const [balances, setBalances] = useState<Balance[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [payErrors, setPayErrors] = useState<Record<string, string>>({})
  const [paying, setPaying] = useState<Set<string>>(new Set())
  // One key per share, kept while a retry could still be needed.
  const keys = useRef(new Map<string, string>())

  const id = encodeURIComponent(homeId)

  const load = useCallback(async () => {
    try {
      const [b, bal] = await Promise.all([
        api<{ bills: Bill[] }>(`/api/homes/${id}/bills`),
        api<{ balances: Balance[] }>(`/api/homes/${id}/balances`),
      ])
      setBills(b.bills)
      setBalances(bal.balances)
      setLoadError(null)
    } catch (err) {
      setLoadError(messageOf(err))
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  async function pay(billId: string, shareId: string) {
    let key = keys.current.get(shareId)
    if (!key) {
      key = crypto.randomUUID()
      keys.current.set(shareId, key)
    }
    setPaying((p) => new Set(p).add(shareId))
    setPayErrors(({ [shareId]: _removed, ...rest }) => rest)
    try {
      await api(
        `/api/bills/${encodeURIComponent(billId)}/shares/${encodeURIComponent(shareId)}/pay`,
        { method: 'POST', headers: { 'Idempotency-Key': key } },
      )
      keys.current.delete(shareId)
      await load()
    } catch (err) {
      // A 4xx answer is final, so the next click gets a new key.
      // Network errors and 5xx may hide a success, so those retries reuse the key.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        keys.current.delete(shareId)
        void load()
      }
      // The share stays unpaid on screen: we only change it after a success.
      setPayErrors((p) => ({ ...p, [shareId]: messageOf(err) }))
    } finally {
      setPaying((p) => {
        const next = new Set(p)
        next.delete(shareId)
        return next
      })
    }
  }

  if (!bills || !balances) {
    if (loadError) {
      return (
        <div role="alert">
          <p>Could not load this home: {loadError}</p>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )
    }
    return <p>Loading…</p>
  }

  return (
    <>
      {loadError && (
        <div role="alert">
          <p>Could not refresh: {loadError}</p>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      <h2>Members</h2>
      {balances.length === 0 ? (
        <p>No members yet. Add one to start splitting bills.</p>
      ) : (
        <ul>
          {balances.map((b) => (
            <li key={b.memberId}>
              {b.name}: owes {money(b.outstandingCents)}
            </li>
          ))}
        </ul>
      )}
      <AddMemberForm homeId={id} onAdded={() => void load()} />

      <h2>Bills</h2>
      <AddBillForm homeId={id} onAdded={() => void load()} />
      {bills.length === 0 ? (
        <p>No bills yet.</p>
      ) : (
        bills.map((bill) => (
          <section key={bill.id}>
            <h3>
              {bill.title} – {money(bill.totalCents)}
            </h3>
            <ul>
              {bill.shares.map((share) => (
                <li key={share.id}>
                  {share.memberName}: {money(share.amountCents)}{' '}
                  {share.paidAt ? (
                    <strong>Paid</strong>
                  ) : (
                    <button
                      type="button"
                      disabled={paying.has(share.id)}
                      onClick={() => void pay(bill.id, share.id)}
                    >
                      {paying.has(share.id) ? 'Paying…' : 'Pay'}
                    </button>
                  )}
                  {payErrors[share.id] && <span role="alert"> {payErrors[share.id]}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  )
}

function AddMemberForm({ homeId, onAdded }: { homeId: string; onAdded: () => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api(`/api/homes/${homeId}/members`, jsonPost({ name }))
      setName('')
      onAdded()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <label>
        New member <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>{' '}
      <button type="submit" disabled={busy}>
        {busy ? 'Adding…' : 'Add member'}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

function AddBillForm({ homeId, onAdded }: { homeId: string; onAdded: () => void }) {
  const [title, setTitle] = useState('')
  const [total, setTotal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // The server checks the amount. Empty or bad input comes back as an error.
      await api(`/api/homes/${homeId}/bills`, jsonPost({ title, totalCents: Number(total) }))
      setTitle('')
      setTotal('')
      onAdded()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <label>
        Title <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>{' '}
      <label>
        Total (cents){' '}
        <input value={total} inputMode="numeric" onChange={(e) => setTotal(e.target.value)} />
      </label>{' '}
      <button type="submit" disabled={busy}>
        {busy ? 'Adding…' : 'Add bill'}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

import type { Context } from 'hono'
import { Hono } from 'hono'

type AppEnv = { Bindings: Env }
type Ctx = Context<AppEnv>

const app = new Hono<AppEnv>()

app.get('/api/health', (c) => c.json({ status: 'ok' }))

// ---------- helpers ----------

const fail = (c: Ctx, status: 400 | 404 | 409 | 422, error: string) => c.json({ error }, status)

async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** 1000 over 3 -> [334, 333, 333]. Extra cents go to the earliest members. */
export function splitCents(total: number, count: number): number[] {
  const base = Math.floor(total / count)
  const extra = total % count
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0))
}

async function homeExists(db: D1Database, homeId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM homes WHERE id = ?').bind(homeId).first()
  return row !== null
}

type ShareDto = {
  id: string
  memberId: string
  amountCents: number
  paidAt: string | null
}

// ---------- Part 1 ----------

app.post('/api/homes', async (c) => {
  const name = cleanName((await readBody(c)).name)
  if (!name) return fail(c, 422, 'name is required')
  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO homes (id, name) VALUES (?, ?)').bind(id, name).run()
  return c.json({ id, name }, 201)
})

app.post('/api/homes/:homeId/members', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) {
    return fail(c, 404, 'home not found')
  }
  const name = cleanName((await readBody(c)).name)
  if (!name) return fail(c, 422, 'name is required')

  const id = crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO members (id, home_id, name) VALUES (?, ?, ?)')
    .bind(id, homeId, name)
    .run()
  return c.json({ id, homeId, name }, 201)
})

// ---------- Part 2 ----------

app.post('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) {
    return fail(c, 404, 'home not found')
  }

  const body = await readBody(c)
  const title = cleanName(body.title)
  const total = body.totalCents
  if (!title) return fail(c, 422, 'title is required')
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total <= 0) {
    return fail(c, 422, 'totalCents must be a positive whole number')
  }

  const { results: members } = await c.env.DB.prepare(
    'SELECT id FROM members WHERE home_id = ? ORDER BY rowid',
  )
    .bind(homeId)
    .all<{ id: string }>()
  if (members.length === 0) return fail(c, 422, 'home has no members')

  const billId = crypto.randomUUID()
  const amounts = splitCents(total, members.length)
  const shares: ShareDto[] = members.map((m, i) => ({
    id: crypto.randomUUID(),
    memberId: m.id,
    amountCents: amounts[i] ?? 0,
    paidAt: null,
  }))

  // One batch is one transaction: a bill never exists without all its shares.
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO bills (id, home_id, title, total_cents) VALUES (?, ?, ?, ?)',
    ).bind(billId, homeId, title, total),
    ...shares.map((s) =>
      c.env.DB.prepare(
        'INSERT INTO shares (id, bill_id, member_id, amount_cents) VALUES (?, ?, ?, ?)',
      ).bind(s.id, billId, s.memberId, s.amountCents),
    ),
  ])

  return c.json({ id: billId, homeId, title, totalCents: total, shares }, 201)
})

// Needed by the web page. Not in the spec.
app.get('/api/homes/:homeId/bills', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) {
    return fail(c, 404, 'home not found')
  }

  const { results: bills } = await c.env.DB.prepare(
    'SELECT id, title, total_cents AS totalCents FROM bills WHERE home_id = ? ORDER BY rowid',
  )
    .bind(homeId)
    .all<{ id: string; title: string; totalCents: number }>()

  const { results: rows } = await c.env.DB.prepare(
    `SELECT s.id, s.bill_id AS billId, s.member_id AS memberId,
            m.name AS memberName, s.amount_cents AS amountCents,
            s.paid_at AS paidAt
     FROM shares s
     JOIN bills b ON b.id = s.bill_id
     JOIN members m ON m.id = s.member_id
     WHERE b.home_id = ? ORDER BY s.rowid`,
  )
    .bind(homeId)
    .all<ShareDto & { billId: string; memberName: string }>()

  return c.json({
    bills: bills.map((b) => ({
      ...b,
      homeId,
      shares: rows.filter((r) => r.billId === b.id),
    })),
  })
})

app.post('/api/bills/:billId/shares/:shareId/pay', async (c) => {
  const key = c.req.header('Idempotency-Key')?.trim()
  if (!key) return fail(c, 400, 'Idempotency-Key header is required')

  const billId = c.req.param('billId')
  const shareId = c.req.param('shareId')
  const paidAt = new Date().toISOString()

  // Atomic compare-and-set: only one concurrent request can match paid_at IS NULL.
  const result = await c.env.DB.prepare(
    'UPDATE shares SET paid_at = ?, payment_key = ? WHERE id = ? AND bill_id = ? AND paid_at IS NULL',
  )
    .bind(paidAt, key, shareId, billId)
    .run()

  const share = await c.env.DB.prepare(
    `SELECT id, member_id AS memberId, amount_cents AS amountCents,
            paid_at AS paidAt, payment_key AS paymentKey
     FROM shares WHERE id = ? AND bill_id = ?`,
  )
    .bind(shareId, billId)
    .first<ShareDto & { paymentKey: string | null }>()
  if (!share) return fail(c, 404, 'share not found')

  if (result.meta.changes === 0 && share.paymentKey !== key) {
    return fail(c, 409, 'share already paid with a different key')
  }

  const dto: ShareDto = {
    id: share.id,
    memberId: share.memberId,
    amountCents: share.amountCents,
    paidAt: share.paidAt,
  }
  return c.json(dto, 200)
})

app.get('/api/homes/:homeId/balances', async (c) => {
  const homeId = c.req.param('homeId')
  if (!(await homeExists(c.env.DB, homeId))) {
    return fail(c, 404, 'home not found')
  }

  const { results } = await c.env.DB.prepare(
    `SELECT m.id AS memberId, m.name AS name,
            COALESCE(SUM(CASE WHEN s.paid_at IS NULL THEN s.amount_cents END), 0) AS outstandingCents
     FROM members m LEFT JOIN shares s ON s.member_id = m.id
     WHERE m.home_id = ? GROUP BY m.id ORDER BY m.rowid`,
  )
    .bind(homeId)
    .all<{ memberId: string; name: string; outstandingCents: number }>()
  return c.json({ balances: results })
})

// ---------- errors are always JSON ----------

app.notFound((c) => c.json({ error: 'not found' }, 404))
app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'internal server error' }, 500)
})

export default app

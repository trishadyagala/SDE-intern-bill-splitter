import { describe, expect, it } from 'vitest'
import { call, createBill, createHome, type Share } from './helpers'

function pay(billId: string, shareId: string, key: string) {
  return call<Share>('POST', `/api/bills/${billId}/shares/${shareId}/pay`, {
    headers: { 'Idempotency-Key': key },
  })
}

describe('concurrent payments', () => {
  it('different keys at the same time: one 200, one 409', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')

    const results = await Promise.all([
      pay(bill.body.id, share.id, crypto.randomUUID()),
      pay(bill.body.id, share.id, crypto.randomUUID()),
    ])

    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
  })

  it('same key at the same time: both 200, same paidAt', async () => {
    const { homeId } = await createHome(['Asha', 'Ben'])
    const bill = await createBill(homeId, 1000)
    const share = bill.body.shares[0]
    if (!share) throw new Error('no share')
    const key = crypto.randomUUID()

    const [a, b] = await Promise.all([
      pay(bill.body.id, share.id, key),
      pay(bill.body.id, share.id, key),
    ])

    expect(a?.status).toBe(200)
    expect(b?.status).toBe(200)
    expect(a?.body.paidAt).toBe(b?.body.paidAt)
  })
})

describe('bad input', () => {
  it('rejects a blank home name', async () => {
    const res = await call('POST', '/api/homes', { body: { name: '   ' } })
    expect(res.status).toBe(422)
  })

  it('answers unknown routes with a JSON error', async () => {
    const res = await call<{ error: string }>('GET', '/api/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not found' })
  })
})

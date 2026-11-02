CREATE TABLE homes (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL CONSTRAINT homes_name_not_blank CHECK (length(trim(name)) > 0)
);

CREATE TABLE members (
  id      TEXT PRIMARY KEY,
  home_id TEXT NOT NULL CONSTRAINT fk_members_home REFERENCES homes (id),
  name    TEXT NOT NULL CONSTRAINT members_name_not_blank CHECK (length(trim(name)) > 0)
);
CREATE INDEX idx_members_home ON members (home_id);

CREATE TABLE bills (
  id          TEXT PRIMARY KEY,
  home_id     TEXT NOT NULL CONSTRAINT fk_bills_home REFERENCES homes (id),
  title       TEXT NOT NULL CONSTRAINT bills_title_not_blank CHECK (length(trim(title)) > 0),
  total_cents INTEGER NOT NULL CONSTRAINT bills_total_positive CHECK (total_cents > 0)
);
CREATE INDEX idx_bills_home ON bills (home_id);

CREATE TABLE shares (
  id           TEXT PRIMARY KEY,
  bill_id      TEXT NOT NULL CONSTRAINT fk_shares_bill REFERENCES bills (id),
  member_id    TEXT NOT NULL CONSTRAINT fk_shares_member REFERENCES members (id),
  amount_cents INTEGER NOT NULL CONSTRAINT shares_amount_nonneg CHECK (amount_cents >= 0),
  paid_at      TEXT,
  payment_key  TEXT,
  CONSTRAINT uq_shares_bill_member UNIQUE (bill_id, member_id),
  CONSTRAINT shares_paid_state_consistent CHECK ((paid_at IS NULL) = (payment_key IS NULL))
);
CREATE INDEX idx_shares_member ON shares (member_id);
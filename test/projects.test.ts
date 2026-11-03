// Projects, vendors and line items.
//
// The tests that carry weight are the ones about NOT counting money twice, and
// about counting money the narrower tag rollup misses. Those two are the whole
// reason this exists rather than being a use of tags alone.
//
// Company names and contact details here are invented.

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openLedger, addTag } from '../src/core/ledger.js';
import {
  createProject, getProject, listProjects, closeProject,
  upsertVendor, getVendor, listVendors,
  addLineItem, listLineItems, settleLineItem, setLineItemStatus,
  projectReport, totalCommitted, slugify, updateProject,
} from '../src/core/projects.js';
import { seedAccount, seedTxn, type Seeded } from './helpers.js';

let db: Database.Database;
let acct: Seeded;

beforeEach(() => {
  db = openLedger(':memory:');
  acct = seedAccount(db, 'a1');
});

describe('slugify', () => {
  it('turns a name into a usable tag', () => {
    expect(slugify('Deck Rebuild 2026')).toBe('deck-rebuild-2026');
    expect(slugify('  Car — Honda!! ')).toBe('car-honda');
  });
});

describe('createProject', () => {
  it('derives a tag and starts active', () => {
    const p = createProject(db, { name: 'Deck Rebuild', type: 'remodel' });
    expect(p.tag).toBe('deck-rebuild');
    expect(p.type).toBe('remodel');
    expect(p.kind).toBe('project');
    expect(p.status).toBe('active');
  });

  it('refuses a tag another project already owns', () => {
    createProject(db, { name: 'Car' });
    expect(() => createProject(db, { name: 'Car' })).toThrow(/already belongs/);
  });

  it('refuses a budget period on a bounded project', () => {
    // A project's budget is the whole job; a period would silently change what
    // over-budget means.
    expect(() => createProject(db, {
      name: 'Deck', kind: 'project', budgetPeriod: 'monthly',
    })).toThrow(/no period/);
  });

  it('keeps a budget period on something ongoing', () => {
    const p = createProject(db, {
      name: 'Car', kind: 'ongoing', type: 'auto', budgetCents: 50_000, budgetPeriod: 'monthly',
    });
    expect(p.budgetPeriod).toBe('monthly');
  });

  it('finds a project by id, tag or name', () => {
    const p = createProject(db, { name: 'Deck Rebuild' });
    expect(getProject(db, p.projectId)?.projectId).toBe(p.projectId);
    expect(getProject(db, 'deck-rebuild')?.projectId).toBe(p.projectId);
    expect(getProject(db, 'Deck Rebuild')?.projectId).toBe(p.projectId);
    expect(getProject(db, 'nope')).toBeNull();
  });
});

describe('vendors', () => {
  it('stores contact details once and reuses them', () => {
    const v = upsertVendor(db, {
      company: 'Northgate Decking', contactName: 'Sam Reyes',
      phone: '555-0100', email: 'sam@example.com',
    });
    expect(getVendor(db, 'northgate decking')?.vendorId).toBe(v.vendorId);
    expect(listVendors(db)).toHaveLength(1);
  });

  it('updates in place rather than creating a second row', () => {
    // The reason vendors are a table: a phone number is current state. Six
    // copies means five go stale.
    const first = upsertVendor(db, { company: 'Northgate Decking', phone: '555-0100' });
    const second = upsertVendor(db, { company: 'northgate decking', phone: '555-0199' });

    expect(second.vendorId).toBe(first.vendorId);
    expect(second.phone).toBe('555-0199');
    expect(listVendors(db)).toHaveLength(1);
  });

  it('keeps fields the caller did not supply', () => {
    upsertVendor(db, { company: 'Northgate', contactName: 'Sam Reyes', phone: '555-0100' });
    const after = upsertVendor(db, { company: 'Northgate', email: 'sam@example.com' });
    expect(after.contactName).toBe('Sam Reyes');
    expect(after.phone).toBe('555-0100');
    expect(after.email).toBe('sam@example.com');
  });

  it('leaves a line item readable when its vendor is deleted', () => {
    const p = createProject(db, { name: 'Deck' });
    const v = upsertVendor(db, { company: 'Northgate' });
    const item = addLineItem(db, p.projectId, {
      label: 'Exterior labour', amountCents: 800_000, vendorId: v.vendorId,
    });
    db.prepare('DELETE FROM vendors WHERE vendor_id = ?').run(v.vendorId);

    const after = listLineItems(db, p.projectId).find((i) => i.itemId === item.itemId)!;
    expect(after.vendorId).toBeNull();
    expect(after.label).toBe('Exterior labour');   // the label belongs to the cost
    expect(after.amountCents).toBe(800_000);
  });
});

describe('what the ledger contributes', () => {
  it('counts a tagged transfer, which the tag rollup would miss', () => {
    // The case this exists for: a contractor paid by cheque or ACH categorises
    // as `transfer`, and tagTotals counts only purchases and bills. Under that
    // filter a genuinely paid deposit reports as zero.
    const p = createProject(db, { name: 'Deck', budgetCents: 1_000_000 });
    const txn = seedTxn(db, acct, {
      date: '2026-06-01', amountCents: -500_000,
      description: 'CHECK 1042 NORTHGATE DECKING', category: 'transfer',
    });
    addTag(db, txn, p.tag);

    const r = projectReport(db, 'deck')!;
    expect(r.ledgerCents).toBe(500_000);
    expect(r.spentCents).toBe(500_000);
    expect(r.remainingCents).toBe(500_000);
  });

  it('lets a refund reduce the total', () => {
    const p = createProject(db, { name: 'DIY Deck' });
    addTag(db, seedTxn(db, acct, { date: '2026-06-01', amountCents: -50_000, category: 'shopping' }), p.tag);
    addTag(db, seedTxn(db, acct, { date: '2026-06-05', amountCents: 12_000, category: 'shopping' }), p.tag);
    expect(projectReport(db, p.tag)!.spentCents).toBe(38_000);
  });

  it('ignores untagged transactions', () => {
    const p = createProject(db, { name: 'Deck' });
    seedTxn(db, acct, { date: '2026-06-01', amountCents: -100_000, category: 'shopping' });
    expect(projectReport(db, p.tag)!.spentCents).toBe(0);
  });

  it('narrows to a window for an ongoing project', () => {
    // A car's lifetime total answers nothing; this year's does.
    const p = createProject(db, {
      name: 'Car', kind: 'ongoing', budgetCents: 500_000, budgetPeriod: 'yearly',
    });
    for (const [date, cents] of [['2025-06-01', -100_000], ['2026-06-01', -150_000]] as const) {
      addTag(db, seedTxn(db, acct, { date, amountCents: cents, category: 'transportation' }), p.tag);
    }
    expect(projectReport(db, p.tag)!.spentCents).toBe(250_000);
    expect(projectReport(db, p.tag, { startDate: '2026-01-01' })!.spentCents).toBe(150_000);
  });
});

describe('a periodic budget', () => {
  // A $500 monthly budget once reported "$365 left" against three months of
  // fuel, because it was compared with lifetime spend.
  const car = () => createProject(db, {
    name: 'Car', kind: 'ongoing', budgetCents: 50_000, budgetPeriod: 'monthly',
  });
  const fuel = (tag: string, date: string, cents = -4_500) =>
    addTag(db, seedTxn(db, acct, { date, amountCents: cents, category: 'transportation' }), tag);

  it('is measured over the current month, not all time', () => {
    const p = car();
    fuel(p.tag, '2026-07-10'); fuel(p.tag, '2026-08-10'); fuel(p.tag, '2026-09-10');

    const r = projectReport(db, p.tag, undefined, new Date(2026, 8, 20))!;
    expect(r.spentCents).toBe(13_500);
    expect(r.budgetWindow).toEqual({ startDate: '2026-09-01', endDate: '2026-09-30' });
    expect(r.budgetSpentCents).toBe(4_500);
    expect(r.remainingCents).toBe(45_500);
  });

  it('counts off-ledger costs settled inside the period only', () => {
    const p = car();
    addLineItem(db, p.projectId, { label: 'Tyres', amountCents: 30_000, status: 'settled', offLedger: true, settledOn: '2026-09-02' });
    addLineItem(db, p.projectId, { label: 'Old repair', amountCents: 80_000, status: 'settled', offLedger: true, settledOn: '2026-03-02' });
    const r = projectReport(db, p.tag, undefined, new Date(2026, 8, 20))!;
    expect(r.budgetSpentCents).toBe(30_000);
    expect(r.remainingAfterCommitmentsCents).toBe(20_000);
  });

  it('uses the calendar year for a yearly budget', () => {
    const p = createProject(db, { name: 'Boat', kind: 'ongoing', budgetCents: 100_000, budgetPeriod: 'yearly' });
    fuel(p.tag, '2025-12-31', -60_000); fuel(p.tag, '2026-01-01', -10_000);
    const r = projectReport(db, p.tag, undefined, new Date(2026, 5, 1))!;
    expect(r.budgetWindow).toEqual({ startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(r.remainingCents).toBe(90_000);
  });

  it('defers to a window the caller chose, and leaves a bounded budget whole', () => {
    const p = car();
    fuel(p.tag, '2026-07-10'); fuel(p.tag, '2026-08-10');
    const r = projectReport(db, p.tag, { startDate: '2026-07-01' }, new Date(2026, 8, 20))!;
    expect(r.budgetWindow).toBeNull();
    expect(r.budgetSpentCents).toBe(9_000);

    const job = createProject(db, { name: 'Deck', budgetCents: 100_000 });
    fuel(job.tag, '2025-01-01', -40_000);
    expect(projectReport(db, job.tag)!.remainingCents).toBe(60_000);
  });
});

describe('committed money is never spent money', () => {
  it('reports a commitment as exposure, not spend', () => {
    const p = createProject(db, { name: 'Deck', budgetCents: 1_000_000 });
    addLineItem(db, p.projectId, {
      label: '50% deposit', amountCents: 500_000, status: 'committed',
    });

    const r = projectReport(db, p.tag)!;
    expect(r.spentCents).toBe(0);
    expect(r.committedCents).toBe(500_000);
    expect(r.exposureCents).toBe(500_000);
    expect(r.remainingCents).toBe(1_000_000);              // a promise spends nothing
    expect(r.remainingAfterCommitmentsCents).toBe(500_000); // but it is owed
  });

  it('does not count a deposit twice once paid and settled', () => {
    // The trap: record the commitment, pay it, tag the payment, and a naive
    // sum reports $10,000 of exposure on a $5,000 deposit.
    const p = createProject(db, { name: 'Deck', budgetCents: 1_000_000 });
    const item = addLineItem(db, p.projectId, {
      label: '50% deposit', amountCents: 500_000, status: 'committed',
    });
    addTag(db, seedTxn(db, acct, {
      date: '2026-06-10', amountCents: -500_000, category: 'transfer',
    }), p.tag);

    expect(projectReport(db, p.tag)!.exposureCents).toBe(1_000_000);  // still open

    settleLineItem(db, item.itemId, '2026-06-10');
    const after = projectReport(db, p.tag)!;
    expect(after.spentCents).toBe(500_000);
    expect(after.committedCents).toBe(0);
    expect(after.exposureCents).toBe(500_000);
  });

  it('keeps quoted work out of exposure', () => {
    // Priced is not agreed. Counting a quote as owed would make every estimate
    // you collected look like a debt.
    const p = createProject(db, { name: 'Kitchen', budgetCents: 2_000_000 });
    addLineItem(db, p.projectId, { label: 'Cabinets quote A', amountCents: 900_000 });
    addLineItem(db, p.projectId, { label: 'Cabinets quote B', amountCents: 750_000 });

    const r = projectReport(db, p.tag)!;
    expect(r.quotedCents).toBe(1_650_000);
    expect(r.committedCents).toBe(0);
    expect(r.exposureCents).toBe(0);
  });

  it('drops a cancelled item from every total', () => {
    const p = createProject(db, { name: 'Kitchen' });
    const item = addLineItem(db, p.projectId, {
      label: 'Cabinets', amountCents: 900_000, status: 'committed',
    });
    setLineItemStatus(db, item.itemId, 'cancelled');

    const r = projectReport(db, p.tag)!;
    expect(r.committedCents).toBe(0);
    expect(r.exposureCents).toBe(0);
  });
});

describe('off-ledger costs', () => {
  it('count as spend, because they really left your hands', () => {
    const p = createProject(db, { name: 'DIY Deck', budgetCents: 200_000 });
    addLineItem(db, p.projectId, {
      label: 'Cash to helper', amountCents: 30_000, status: 'settled', offLedger: true,
    });
    addTag(db, seedTxn(db, acct, { date: '2026-06-01', amountCents: -50_000, category: 'shopping' }), p.tag);

    const r = projectReport(db, p.tag)!;
    expect(r.ledgerCents).toBe(50_000);
    expect(r.offLedgerCents).toBe(30_000);
    expect(r.spentCents).toBe(80_000);
    expect(r.remainingCents).toBe(120_000);
  });

  it('does NOT count a settled item the ledger already has', () => {
    // Settled without off_ledger means the transaction exists and is tagged.
    // Counting the line item too would double it.
    const p = createProject(db, { name: 'Deck' });
    addLineItem(db, p.projectId, {
      label: 'Deposit', amountCents: 500_000, status: 'settled',
    });
    addTag(db, seedTxn(db, acct, {
      date: '2026-06-10', amountCents: -500_000, category: 'transfer',
    }), p.tag);

    expect(projectReport(db, p.tag)!.spentCents).toBe(500_000);
  });

  it('refuses an off-ledger cost that is not settled', () => {
    const p = createProject(db, { name: 'Deck' });
    expect(() => addLineItem(db, p.projectId, {
      label: 'Cash', amountCents: 10_000, status: 'committed', offLedger: true,
    })).toThrow(/must be settled/);
  });

  it('rejects a negative amount', () => {
    const p = createProject(db, { name: 'Car', kind: 'ongoing' });
    expect(() => addLineItem(db, p.projectId, { label: 'x', amountCents: -100 }))
      .toThrow(/positive whole number/);
  });
});

describe('rollup', () => {
  it('totals commitments across live projects only', () => {
    const a = createProject(db, { name: 'Deck' });
    const b = createProject(db, { name: 'Kitchen' });
    addLineItem(db, a.projectId, { label: 'Deposit', amountCents: 500_000, status: 'committed' });
    addLineItem(db, b.projectId, { label: 'Cabinets', amountCents: 300_000, status: 'committed' });
    expect(totalCommitted(db)).toBe(800_000);

    closeProject(db, b.projectId, 'cancelled');   // not money you owe
    expect(totalCommitted(db)).toBe(500_000);
  });

  it('hides closed projects from the default list', () => {
    const a = createProject(db, { name: 'Deck' });
    createProject(db, { name: 'Car', kind: 'ongoing' });
    closeProject(db, a.projectId);

    expect(listProjects(db).map((p) => p.name)).toEqual(['Car']);
    expect(listProjects(db, true)).toHaveLength(2);
  });

  it('carries vendor contact details onto the line items', () => {
    const p = createProject(db, { name: 'Deck' });
    const v = upsertVendor(db, {
      company: 'Northgate Decking', contactName: 'Sam Reyes', phone: '555-0100',
    });
    addLineItem(db, p.projectId, {
      label: 'Exterior labour', amountCents: 800_000, status: 'committed', vendorId: v.vendorId,
    });

    const item = projectReport(db, p.tag)!.items[0]!;
    expect(item.vendor?.company).toBe('Northgate Decking');
    expect(item.vendor?.phone).toBe('555-0100');
  });
});

describe('updateProject', () => {
  it('changes only what it is given', () => {
    const p = createProject(db, {
      name: 'Deck', type: 'remodel', budgetCents: 1_000_000, note: 'original',
    });
    const after = updateProject(db, p.tag, { note: 'blocked on colour choice' });

    expect(after.note).toBe('blocked on colour choice');
    expect(after.budgetCents).toBe(1_000_000);   // untouched
    expect(after.type).toBe('remodel');
  });

  it('distinguishes "leave alone" from "clear it"', () => {
    const p = createProject(db, { name: 'Deck', budgetCents: 1_000_000, note: 'x' });
    expect(updateProject(db, p.tag, {}).budgetCents).toBe(1_000_000);
    expect(updateProject(db, p.tag, { budgetCents: null }).budgetCents).toBeNull();
  });

  it('refuses a budget period on a bounded project', () => {
    const p = createProject(db, { name: 'Deck' });
    expect(() => updateProject(db, p.tag, { budgetPeriod: 'monthly' })).toThrow(/no period/);
  });

  it('has no way to change the tag, which would orphan tagged spend', () => {
    // Not an assertion about an error — the field simply is not in the patch
    // type. Changing the join key would drop the project's spend to zero with
    // nothing to explain why.
    const p = createProject(db, { name: 'Deck' });
    addTag(db, seedTxn(db, acct, { date: '2026-06-01', amountCents: -50_000, category: 'shopping' }), p.tag);
    updateProject(db, p.tag, { name: 'Deck Rebuild 2026' });

    const r = projectReport(db, p.tag)!;
    expect(r.project.tag).toBe('deck');
    expect(r.spentCents).toBe(50_000);
  });
});

// The spend-group split is the load-bearing correctness property in this
// project: if a credit-card payment counts as spending, then linking both a card
// and the checking account that pays it double-counts every purchase on that
// card. These tests pin that, plus the description inference the CSV provider
// depends on.

import { describe, it, expect } from 'vitest';
import {
  spendGroupFor,
  countsAsSpending,
  inferCategory,
  normalizeDescription,
  CATEGORIES,
  isCategory,
  resolveCategory,
  creditNotIncome,
} from '../src/core/normalize.js';

describe('spendGroupFor', () => {
  it('treats a CARD payment as movement — its purchases are already counted', () => {
    expect(spendGroupFor('credit_card_payment')).toBe('payments');
    expect(countsAsSpending('payments')).toBe(false);
  });

  it('treats a LOAN payment as real spending', () => {
    // The asymmetry is deliberate and was found in real data. A card's
    // purchases appear in the ledger, so counting the payment too would
    // double-count. A loan reports a balance, not purchases — nothing else
    // accounts for a mortgage payment, so excluding it made every mortgage payment
    // vanish and overstated net income by the same amount.
    expect(spendGroupFor('loan_payment')).toBe('bills');
    expect(countsAsSpending(spendGroupFor('loan_payment'))).toBe(true);
  });

  it('treats transfers and income as movement, not spending', () => {
    expect(spendGroupFor('transfer')).toBe('transfers');
    expect(spendGroupFor('income')).toBe('income');
    expect(countsAsSpending('transfers')).toBe(false);
    expect(countsAsSpending('income')).toBe(false);
  });

  it('counts recurring obligations as bills', () => {
    for (const c of ['housing', 'utilities', 'insurance', 'taxes', 'fees'] as const) {
      expect(spendGroupFor(c)).toBe('bills');
      expect(countsAsSpending(spendGroupFor(c))).toBe(true);
    }
  });

  it('counts discretionary categories as purchases', () => {
    for (const c of ['groceries', 'dining', 'shopping', 'travel'] as const) {
      expect(spendGroupFor(c)).toBe('purchases');
      expect(countsAsSpending(spendGroupFor(c))).toBe(true);
    }
  });

  it('assigns every canonical category to a group', () => {
    for (const c of CATEGORIES) {
      expect(spendGroupFor(c)).toBeTruthy();
    }
  });

  it('rejects non-canonical category strings', () => {
    expect(isCategory('groceries')).toBe(true);
    expect(isCategory('Groceries')).toBe(false);
    expect(isCategory('made_up')).toBe(false);
  });
});

describe('inferCategory', () => {
  it('recognises a credit-card payment so it is excluded from spending', () => {
    // The exact failure this project exists to avoid: a $2,100 card payment
    // must not read as $2,100 of new spending.
    const category = inferCategory('CARD ISSUER CARD PMT AUTOPAY', -210_000);
    expect(category).toBe('credit_card_payment');
    expect(countsAsSpending(spendGroupFor(category))).toBe(false);
  });

  it('recognises common spending merchants', () => {
    expect(inferCategory('GROCERY MART #412 SPRINGFIELD', -8_432)).toBe('groceries');
    expect(inferCategory('STARBUCKS STORE 1234', -725)).toBe('dining');
    expect(inferCategory('SHELL OIL 57445', -4_500)).toBe('transportation');
    expect(inferCategory('NETFLIX.COM', -1_599)).toBe('entertainment');
  });

  // Descriptions taken from a real bank export. Every one of these was
  // missed by the first pattern set and landed in `other` — which meant a
  // large sum of card payments counted as spending, and would have been double-counted again
  // when the card itself was imported.
  it('recognises issuer payments that never say the word "card"', () => {
    const real = 'CARD ISSUER      MOBILE PMT        CA0E4D9449C68F5 Jane Q Public';
    const category = inferCategory(real, -250_000);
    expect(category).toBe('credit_card_payment');
    expect(countsAsSpending(spendGroupFor(category))).toBe(false);
  });

  it('recognises abbreviated loan servicers', () => {
    const real = 'LOAN SERVICER PPD STUDNTLOAN 123456 0000            JANE  PUBLIC';
    expect(inferCategory(real, -15_000)).toBe('loan_payment');
  });

  it.each([
    'CHASE CREDIT CRD EPAY',
    'DISCOVER         E-PAYMENT',
    'AMEX EPAYMENT   ACH PMT',
    'BANK OF AMERICA CREDIT CARD PAYMENT',
  ])('recognises %s as a card payment', (description) => {
    expect(inferCategory(description, -50_000)).toBe('credit_card_payment');
  });

  it('matches the payment family, not one spelling of it', () => {
    // The two sides of a single real transaction: the paying bank writes
    // the outgoing leg "MOBILE PMT", the card issuer writes the incoming leg
    // "MOBILE PYMT". Knowing only one spelling put a large sum in the wrong bucket.
    expect(inferCategory('CARD ISSUER      MOBILE PMT', -100, 'depository'))
      .toBe('credit_card_payment');
    expect(inferCategory('CHASE MOBILE PYMT', 100, 'credit'))
      .toBe('credit_card_payment');
    for (const spelling of ['MOBILE PYMT', 'ONLINE PMNT', 'WEB PAYMT', 'ACH PAYMENT']) {
      expect(inferCategory(`SOMEBANK ${spelling}`, 100, 'credit')).toBe('credit_card_payment');
    }
  });

  it('does NOT call a paycheck a card payment just because the employer is a bank', () => {
    // Plenty of people are paid by a bank, so the issuer name appears on
    // income rows too. The issuer pattern requires a payment word, and the
    // income pattern matches first.
    expect(inferCategory('EMPLOYER DIRECT DEP PAYROLL', 500_000)).toBe('income');
  });

  describe('the two sides of a card payment', () => {
    // The same payment appears twice when both accounts are imported: money OUT
    // of checking, money IN to the card. Both must land in `payments` so they
    // net to zero and neither touches the spending total.
    it('is a payment leaving the checking account', () => {
      expect(inferCategory('CARD ISSUER MOBILE PMT', -210_000, 'depository'))
        .toBe('credit_card_payment');
    });

    it('is the same payment arriving at the card', () => {
      expect(inferCategory('PAYMENT THANK YOU', 210_000, 'credit'))
        .toBe('credit_card_payment');
    });

    it('but money IN to a checking account is a refund, not a payment', () => {
      // Excluding a statement credit as if it settled a balance would
      // understate what was actually spent.
      expect(inferCategory('CARD ISSUER MOBILE PMT REVERSAL', 25_000, 'depository'))
        .toBe('income');
    });

    it('defaults to the asset-account reading when type is unknown', () => {
      expect(inferCategory('CARD ISSUER MOBILE PMT REVERSAL', 25_000)).toBe('income');
    });
  });

  it('recognises bills', () => {
    expect(inferCategory('MORTGAGE PMT', -200_000)).toBe('loan_payment');
    expect(inferCategory('XFINITY INTERNET', -8_900)).toBe('utilities');
    expect(inferCategory('GEICO INSURANCE', -14_200)).toBe('insurance');
  });

  it('recognises income and transfers', () => {
    expect(inferCategory('DIRECT DEP PAYROLL', 500_000)).toBe('income');
    expect(inferCategory('ZELLE TO SAVINGS', -20_000)).toBe('transfer');
  });

  it('falls back by direction when nothing matches', () => {
    // Unmatched money-in is far more likely income than an unclassified purchase.
    expect(inferCategory('QQQ UNKNOWN THING', 5_000)).toBe('income');
    expect(inferCategory('QQQ UNKNOWN THING', -5_000)).toBe('other');
  });

  it('is case-insensitive', () => {
    expect(inferCategory('kroger #412', -100)).toBe('groceries');
    expect(inferCategory('GROCERY MART #412', -100)).toBe('groceries');
  });
});

describe('normalizeDescription', () => {
  it('collapses whitespace and case so hashing is stable', () => {
    expect(normalizeDescription('  GROCERY MART   #412   TX ')).toBe('grocery mart #412 tx');
    expect(normalizeDescription('Grocery Mart #412 TX')).toBe('grocery mart #412 tx');
  });
});

describe('moving money to your own investment account', () => {
  // A brokerage or retirement account is yours. Money going in is not
  // spending; money coming back is not income. It is the same money changing
  // pockets, and counting it either way corrupts BOTH totals.
  //
  // Get it wrong and brokerage withdrawals count as income and deposits as
  // "professional services", inflating measured income — and affordability is
  // computed from that number.
  it.each([
    'FID BKG SVC LLC MONEYLINE 010203 A000000001',
    'FIDELITY INVESTMENTS',
    'VANGUARD BUY',
    'CHARLES SCHWAB BROKERAGE',
    'E*TRADE ACH',
    'TD AMERITRADE',
    'ROBINHOOD',
    'BETTERMENT DEPOSIT',
    'COINBASE INC',
  ])('treats %s as a transfer, not spending', (description) => {
    const category = inferCategory(description, -500_000);
    expect(category).toBe('transfer');
    expect(countsAsSpending(spendGroupFor(category))).toBe(false);
  });

  it('treats the money coming BACK as a transfer too, not income', () => {
    // The direction that inflates income, which is the one that matters for
    // affordability.
    expect(inferCategory('SCHWAB BROKERAGE MONEYLINK 000002', 900_000))
      .toBe('transfer');
  });

  it('treats retirement contributions as savings rather than spend', () => {
    expect(inferCategory('401K CONTRIBUTION', -100_000)).toBe('transfer');
    expect(inferCategory('ROTH IRA DEPOSIT', -50_000)).toBe('transfer');
  });

  it('does not swallow a paycheque from a financial employer', () => {
    // The pattern matches an institution name, so it must not outrank income.
    expect(inferCategory('SCHWAB DIRECT DEP PAYROLL', 500_000)).toBe('income');
  });
});

describe('booking platforms, which bill under their own name', () => {
  it('files a salon booking as personal care, not transport', () => {
    // Found by the report's own AI narration, which noticed a
    // "VAGARO_SALON_BOOKING" charge sitting in transportation and said the
    // category looked wrong. Vagaro is salon and spa scheduling software.
    expect(inferCategory('VAGARO_SALON_BOOKING', -6_500)).toBe('personal_care');
    expect(inferCategory('Mindbody Inc', -8_000)).toBe('personal_care');
  });

  it('matches when the name runs into an underscore', () => {
    // The reason the first attempt at this rule did nothing: \b requires a
    // non-word character next, and _ IS a word character. "VAGARO_SALON_BOOKING"
    // therefore never matched /\bvagaro\b/, and the rule failed silently —
    // which is how a pattern list rots.
    expect(inferCategory('VAGARO_SALON_BOOKING', -6_500)).toBe('personal_care');
    expect(inferCategory('VAGARO_SALON_BOOKING', -5_000)).toBe('personal_care');
  });

  it('does not shadow a genuine transport merchant', () => {
    expect(inferCategory('SHELL OIL 57445', -4_500)).toBe('transportation');
    expect(inferCategory('UBER TRIP', -2_200)).toBe('transportation');
  });
});

describe('money arriving on a card', () => {
  // Found building a demo ledger: a $54.20 refund on a credit card, matching no
  // merchant pattern, was filed as income. That inflates income by every card
  // refund and leaves the purchase it undoes in spending.
  it('is a credit against spending, never income', () => {
    const category = inferCategory('PARCELMART*REFUND', 5_420, 'credit');
    expect(category).not.toBe('income');
    expect(countsAsSpending(spendGroupFor(category))).toBe(true);
    expect(inferCategory('QQQ UNKNOWN THING', 5_000, 'loan')).not.toBe('income');
  });

  it('takes the bank\'s own label when it has one', () => {
    expect(resolveCategory('PARCELMART*REFUND', 5_420, 'credit', 'Merchandise'))
      .toEqual({ category: 'shopping', source: 'provider' });
  });

  it('reads a labelled credit on checking as a refund too, not pay', () => {
    expect(resolveCategory('ONLINE STORE CREDIT 8812', 3_000, 'depository', 'Merchandise').category)
      .toBe('shopping');
  });

  it('still reads unlabelled money into checking as income', () => {
    expect(resolveCategory('QQQ UNKNOWN THING', 5_000, 'depository', null).category).toBe('income');
    expect(inferCategory('QQQ UNKNOWN THING', 5_000)).toBe('income');
  });

  it('applies to a provider whose mapping says income', () => {
    expect(creditNotIncome('income', 5_000, 'credit')).toBe('other');
    expect(creditNotIncome('income', 5_000, 'depository')).toBe('income');
    expect(creditNotIncome('income', -5_000, 'credit')).toBe('income');
  });
});

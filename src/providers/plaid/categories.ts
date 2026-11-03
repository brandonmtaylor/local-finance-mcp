// Plaid category → canonical category.
//
// IMPORTANT: the Plaid CLI emits the LEGACY hierarchical `category` array
// (e.g. ["Food and Drink", "Restaurants", "Coffee Shop"]), NOT the newer
// `personal_finance_category` object. Verified against real sandbox output —
// personal_finance_category was absent from all 50 transactions. A mapper
// written against PFC would silently categorise everything as "other".
//
// The legacy taxonomy's top level is: Bank Fees, Cash Advance, Community,
// Food and Drink, Healthcare, Interest, Payment, Recreation, Service, Shops,
// Tax, Transfer, Travel.

import type { Category } from '../../core/normalize.js';

/**
 * Refinements keyed on the second level, where the top level alone is too
 * coarse to preserve the spending/movement distinction or a useful breakdown.
 */
const DETAIL_MAP: Record<string, Record<string, Category>> = {
  'Food and Drink': {
    Groceries: 'groceries',
    Supermarkets: 'groceries',
    Restaurants: 'dining',
  },
  Travel: {
    // Everyday travel is transportation; trips are travel. Lumping them makes
    // "how much do we spend getting around" unanswerable.
    Taxi: 'transportation',
    'Ride Share': 'transportation',
    'Public Transportation Services': 'transportation',
    'Gas Stations': 'transportation',
    Parking: 'transportation',
    Tolls: 'transportation',
    'Car Service': 'transportation',
  },
  Payment: {
    // A card payment settles a balance whose purchases were already counted.
    // Misclassifying this as spending is the double-count bug.
    'Credit Card': 'credit_card_payment',
    Loan: 'loan_payment',
    Rent: 'housing',
  },
  Transfer: {
    // Interest and dividends arrive tagged as transfers but are genuinely income.
    Interest: 'income',
    Dividend: 'income',
    Payroll: 'income',
    Deposit: 'transfer',
    Credit: 'transfer',
    Debit: 'transfer',
    'Third Party': 'transfer',
    ACH: 'transfer',
    Wire: 'transfer',
    'Credit Card': 'credit_card_payment',
  },
  Service: {
    Insurance: 'insurance',
    Utilities: 'utilities',
    'Telecommunication Services': 'utilities',
    Education: 'education',
    Childcare: 'childcare',
    'Personal Care': 'personal_care',
    'Financial Services': 'professional_services',
    'Legal Services': 'professional_services',
    'Automotive Services': 'transportation',
  },
  Recreation: {
    'Gyms and Fitness Centers': 'personal_care',
  },
  Community: {
    'Religious Organizations': 'charity',
    Charities: 'charity',
    Education: 'education',
    Government: 'taxes',
  },
};

/** Fallback when the second level is absent or unrecognised. */
const PRIMARY_MAP: Record<string, Category> = {
  'Bank Fees': 'fees',
  'Cash Advance': 'transfer',
  Community: 'charity',
  'Food and Drink': 'dining',
  Healthcare: 'health',
  Interest: 'income',
  Payment: 'credit_card_payment',
  Recreation: 'entertainment',
  Service: 'professional_services',
  Shops: 'shopping',
  Tax: 'taxes',
  Transfer: 'transfer',
  Travel: 'travel',
};

/**
 * Map a legacy Plaid category array to a canonical category.
 *
 * `amountCents` is the ALREADY-NORMALIZED ledger amount (positive = money in).
 * It only breaks ties the taxonomy can't: a bare "Payment" that brought money
 * IN is a refund, not a card payment.
 */
export function mapPlaidCategory(
  category: readonly string[] | null | undefined,
  amountCents: number,
): { category: Category; source: 'provider' | 'inferred' } {
  if (!category || category.length === 0) {
    return { category: amountCents > 0 ? 'income' : 'other', source: 'inferred' };
  }

  const [primary, detail] = category;
  if (primary === undefined) {
    return { category: amountCents > 0 ? 'income' : 'other', source: 'inferred' };
  }

  if (detail !== undefined) {
    const mapped = DETAIL_MAP[primary]?.[detail];
    if (mapped) return { category: mapped, source: 'provider' };
  }

  const fallback = PRIMARY_MAP[primary];
  if (fallback) {
    // "Payment" with money coming in is a refund/credit, not a card payment —
    // calling it a payment would wrongly pull it out of the spending total.
    if (fallback === 'credit_card_payment' && amountCents > 0) {
      return { category: 'income', source: 'inferred' };
    }
    return { category: fallback, source: 'provider' };
  }

  return { category: amountCents > 0 ? 'income' : 'other', source: 'inferred' };
}

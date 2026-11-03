// Canonical category taxonomy + spend-group classification.
//
// This project owns its own category vocabulary; providers map INTO it. Without
// that, a Plaid row and a CSV row describing the same coffee end up in different
// buckets and every cross-provider report is wrong.
//
// The purchases/bills vs payments/transfers split is the load-bearing part. If a
// credit-card payment counts as "spending", then linking both a card and the
// checking account that pays it double-counts every purchase on that card. So
// `spending` = purchases + bills only, and internal money movement is reported
// separately rather than folded into a headline number.

/** The canonical categories. Providers map their taxonomy onto these. */
export const CATEGORIES = [
  'income',
  'transfer',
  'loan_payment',
  'credit_card_payment',
  'housing',
  'utilities',
  'groceries',
  'dining',
  'transportation',
  'travel',
  'shopping',
  'entertainment',
  'health',
  'insurance',
  'education',
  'childcare',
  'personal_care',
  'fees',
  'taxes',
  'charity',
  'professional_services',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/**
 * How a transaction participates in a spending total.
 *
 * - `purchases` / `bills` — real spending. These sum to the headline number.
 * - `payments`  — credit-card and loan payments. Settles a balance whose
 *                 purchases were already counted; counting it again double-counts.
 * - `transfers` — money moved between your own accounts, or in/out. Not spending.
 * - `income`    — money in. Never spending.
 */
export type SpendGroup = 'purchases' | 'bills' | 'payments' | 'transfers' | 'income';

const BILLS: ReadonlySet<Category> = new Set<Category>([
  'housing', 'utilities', 'insurance', 'taxes', 'fees', 'childcare', 'education',
  // A mortgage, auto or student loan payment IS spending. Nothing else in the
  // ledger accounts for it: a loan account reports a balance, not purchases, so
  // there is no double-count to avoid. Excluding it makes a mortgage's worth of real
  // outflow invisible every month and overstates net income by the same amount.
  'loan_payment',
]);

// ONLY credit-card payments. A card's purchases are already counted when the
// card is linked, so counting the payment that settles them would count the
// same spending twice. That reasoning does not extend to loans — see above.
const PAYMENTS: ReadonlySet<Category> = new Set<Category>([
  'credit_card_payment',
]);

/** Classify a canonical category into its spend group. */
export function spendGroupFor(category: Category): SpendGroup {
  if (category === 'income') return 'income';
  if (category === 'transfer') return 'transfers';
  if (PAYMENTS.has(category)) return 'payments';
  if (BILLS.has(category)) return 'bills';
  return 'purchases';
}

/** Groups that count toward a spending total. Everything else is movement, not spend. */
export function countsAsSpending(group: SpendGroup): boolean {
  return group === 'purchases' || group === 'bills';
}

// ── Description-based inference (the CSV fallback) ───────────────────────────
//
// A CSV gives you a date, an amount and a free-text description — no category,
// no merchant, no ids. These patterns are a starting point, not a classifier;
// anything they get wrong is fixable per-transaction with `finance categorize`
// or `set_category`, a correction that survives re-syncs.

const PATTERNS: ReadonlyArray<readonly [RegExp, Category]> = [
  // Payroll first, so an employer that happens to be a brokerage or a bank
  // still pays a salary rather than making a transfer.
  [/\b(payroll|direct dep|dir dep|salary|paycheck)\b/i, 'income'],
  // A brokerage or retirement account is YOURS. Money moving to it is not
  // spending and money coming back is not income — it is the same money
  // changing pockets, and counting it either way corrupts both totals.
  //
  // Get it wrong and brokerage withdrawals count as income and deposits as
  // "professional services" — inflating measured income, which affordability
  // is computed from, so the error runs straight into a borrowing decision.
  //
  // Matched on the institution rather than a transfer keyword, because these
  // descriptors rarely contain one: "FID BKG SVC LLC MONEYLINE", "VANGUARD
  // BUY", "SCHWAB BROKERAGE".
  [
    /\b(fid bkg|fidelity|vanguard|schwab|e\*?trade|etrade|td ameritrade|merrill|robinhood|betterment|wealthfront|sofi invest|interactive brokers|ibkr|coinbase|m1 finance|acorns|stash)\b/i,
    'transfer',
  ],
  // Retirement contributions likewise — a 401k or IRA is savings, not spend.
  [/\b(401k|403b|ira contrib|roth|pension contrib|vested)\b/i, 'transfer'],

  // Deliberately NOT refunds. A refund is a purchase reversed, not money
  // earned: as income it inflates earnings AND leaves the original purchase
  // counted in full. Left unmatched it falls through to the merchant rule
  // ("AMAZON.COM REFUND" -> shopping), where the positive amount offsets that
  // category's spending, which is exactly what happened.
  [/\b(interest paid|dividend)\b/i, 'income'],

  // Credit-card payments. Worth the most specificity in this whole list: a miss
  // means the payment counts as spending, and if the card is ALSO imported its
  // purchases are counted a second time. Real descriptions vary far more than
  // the obvious "CARD PMT" — one bank renders a card payment as
  // "CARD ISSUER      MOBILE PMT       <ref> <name>".
  // "Payment" is abbreviated inconsistently even across the two sides of ONE
  // transaction: the paying bank wrote "MOBILE PMT" leaving checking, while
  // the card issuer wrote the same payment arriving as "MOBILE PYMT". Match the
  // family, not any single spelling.
  [/\b(card ?p[ym]{1,2}t|card payment|cc p[ym]{1,2}t|payment thank you|autopay)\b/i, 'credit_card_payment'],
  [
    // An issuer name together with a payment word. Both halves required, so a
    // paycheck from an employer that happens to be a bank stays income.
    /\b(capital one|chase|amex|american express|discover|citi|citibank|barclay|synchrony|us bank|bank of america|bofa)\b[\s\S]*\b(pmt|pymt|pmnt|paymt|payment|epay|e-?pay|autopay)\b/i,
    'credit_card_payment',
  ],
  [/\b(mobile|online|web|phone|ach)\s+(pmt|pymt|pmnt|paymt|payment)\b/i, 'credit_card_payment'],
  [/\b(epay|e-payment|echeck pmt)\b/i, 'credit_card_payment'],

  // Loan servicers abbreviate aggressively — "STUDNTLOAN", "ED SERV".
  [
    /\b(mortgage|student ?loan|studnt ?loan|student ln|auto ?loan|loan ?pmt|loan payment|sallie mae|nelnet|mohela|great lakes|fedloan|ed ?serv)\b/i,
    'loan_payment',
  ],
  // A transfer whose destination is a CARD is a card payment, not internal
  // movement — banks describe these as "ONLINE TRANSFER … TO PLATINUM CARD
  // XXXX3333". Must precede the generic transfer rule below, which would
  // otherwise claim it and quietly keep the payment out of `payments`.
  [/\btransfer\b[\s\S]*\bto\b[\s\S]*\b(card|visa|mastercard|amex)\b/i, 'credit_card_payment'],

  [/\b(transfer|xfer|zelle|venmo|cash app|paypal|wire)\b/i, 'transfer'],

  [/\b(rent|hoa|property ?tax|escrow)\b/i, 'housing'],
  // "utility" must also match "UTILITIES", and city/municipal billing is the
  // usual descriptor for water and waste.
  [/\b(electric|water|gas co|utilit(y|ies)|internet|comcast|xfinity|at&t|verizon|t-?mobile|spectrum|city of [a-z ]*utilit|municipal)\b/i, 'utilities'],
  // Statements abbreviate to "INS" far more often than they spell it out.
  [/\b(insurance|ins billing|ins prem|geico|allstate|state farm|progressive|farmers ins)\b/i, 'insurance'],
  [/\b(irs|franchise tax|dept of revenue)\b/i, 'taxes'],
  [/\b(fee|overdraft|service charge|atm surcharge|late charge|interest charge)\b/i, 'fees'],

  // Fuel wins over any store name. Grocery chains run gas stations under the
  // same brand ("KROGER FUEL", "COSTCO GAS"), and the store pattern
  // would otherwise claim them — filing a tank of gas under groceries.
  [/\b(fuel|gas station)\b/i, 'transportation'],
  [/\b(kroger|safeway|whole foods|trader joe|aldi|publix|wegmans|heb|h-e-b|sprouts|grocery|supermarket|costco|sam's club|instacart|market street)\b/i, 'groceries'],
  // No trailing \b on the delivery brands: descriptors run words together,
  // e.g. "DD *DOORDASHDASHPASS", which \bdoordash\b will not match.
  [/\b(restaurant|cafe|coffee|starbucks|chipotle|mcdonald|doordash|uber ?eats|grubhub|pizza|bar & grill|taco|deli|panera|sonic|whataburger)/i, 'dining'],
  [/\b(uber|lyft|shell|chevron|exxon|bp |gas station|parking|toll|ntta|transit|metro|dart|fuel)\b/i, 'transportation'],
  [/\b(church|parish|st\.? \w+ of|diocese|catholic|baptist|methodist)\b/i, 'charity'],
  [/\b(airline|delta|united air|american air|southwest|hotel|marriott|hilton|airbnb|expedia)\b/i, 'travel'],
  [/\b(amazon|target|walmart|best buy|home depot|lowes|etsy|ebay|ikea)\b/i, 'shopping'],
  // `max` alone claimed OfficeMax and every business with Max in its name, so
  // it is spelled out. `steam` likewise matched steam cleaning.
  [/\b(netflix|spotify|hulu|disney\+?|hbo ?max|cinema|theater|steampowered|playstation|xbox)\b/i, 'entertainment'],
  [/\b(pharmacy|cvs|walgreens|doctor|dental|medical|clinic|hospital|vision)\b/i, 'health'],
  // Booking platforms bill under their own name, so the merchant says nothing
  // about what was bought: Vagaro, Mindbody and Booksy are salon and spa
  // scheduling. Caught by the report's own AI narration, which noticed a recurring
  // "VAGARO_SALON_BOOKING" charge filed as transportation.
  //
  // No trailing \b on the platform names. A word boundary requires a
  // non-word character next, and these descriptors run straight into an
  // underscore — "VAGARO_SALON_BOOKING" — which IS a word character, so \b never
  // matches and the rule silently does nothing.
  [/\b(vagaro|mindbody|booksy|styleseat|fresha|squire)/i, 'personal_care'],
  [/\b(salon|barber|spa|gym|fitness|planet fitness|ymca)\b/i, 'personal_care'],
  [/\b(church|donation|charity|goodwill|red cross)\b/i, 'charity'],
  [/\b(tuition|school|university|college)\b/i, 'education'],
  [/\b(daycare|childcare|preschool)\b/i, 'childcare'],
];

/**
 * Best-effort category from a free-text description.
 *
 * `amountCents` disambiguates direction: a positive (money-in) row matching no
 * pattern is far more likely income than a purchase.
 */
/** Account kinds where a liability is owed, so an incoming amount pays it down. */
const LIABILITY_TYPES: ReadonlySet<string> = new Set(['credit', 'loan']);

export function inferCategory(
  description: string,
  amountCents: number,
  accountType?: string,
): Category {
  return patternCategory(description, amountCents, accountType)
    ?? fallbackCategory(amountCents, accountType);
}

/**
 * What a row with no recognisable description is, by direction alone.
 *
 * Unmatched money IN to a checking account is far more likely pay than an
 * unclassified purchase. On a card or loan it never is: nobody is paid onto a
 * credit card, so an incoming amount there is a refund or a credit. Calling it
 * income inflated income by every card refund AND left the purchase it undoes
 * in spending — the error counted twice, in the direction affordability reads.
 */
function fallbackCategory(amountCents: number, accountType?: string): Category {
  const isLiability = accountType !== undefined && LIABILITY_TYPES.has(accountType);
  return amountCents > 0 && !isLiability ? 'income' : 'other';
}

/**
 * Income never lands on a card or loan. For a provider whose own mapping
 * falls back to "money in = income", applied after it.
 */
export function creditNotIncome(category: Category, amountCents: number, accountType?: string): Category {
  const isLiability = accountType !== undefined && LIABILITY_TYPES.has(accountType);
  return category === 'income' && amountCents > 0 && isLiability ? 'other' : category;
}

/** The category a merchant pattern gives the row, or null when none matches. */
function patternCategory(
  description: string,
  amountCents: number,
  accountType?: string,
): Category | null {
  const text = description.trim();
  const isLiability = accountType !== undefined && LIABILITY_TYPES.has(accountType);

  for (const [pattern, category] of PATTERNS) {
    if (!pattern.test(text)) continue;

    // A card payment has two sides: money OUT of the checking account that sends
    // it, and money IN to the card that receives it. Both are the same payment
    // and both belong in `payments`, where they net to zero and stay out of the
    // spending total.
    //
    // So an incoming amount only means "refund" on an asset account. On a card
    // or loan, incoming IS the payment.
    const isPayment = category === 'credit_card_payment' || category === 'loan_payment';
    if (isPayment && amountCents > 0 && !isLiability) return 'income';

    return category;
  }
  return null;
}

// ── Provider-supplied categories ─────────────────────────────────────────────
//
// Many exports carry the bank's own category column. It is coarse but it covers
// EVERY row, which beats regex guessing on the long tail of merchant names.
// Vocabularies differ by issuer, so this maps the common ones by lowercased
// label rather than assuming a single taxonomy.

const PROVIDER_CATEGORY_MAP: Record<string, Category> = {
  // Capital One
  merchandise: 'shopping',
  dining: 'dining',
  'gas/automotive': 'transportation',
  internet: 'utilities',
  'payment/credit': 'credit_card_payment',
  entertainment: 'entertainment',
  utilities: 'utilities',
  'other services': 'professional_services',
  insurance: 'insurance',
  'phone/cable': 'utilities',
  'professional services': 'professional_services',
  healthcare: 'health',
  'fee/interest charge': 'fees',
  // Common elsewhere (Chase, Amex, Discover, generic exports)
  groceries: 'groceries',
  'food & drink': 'dining',
  'food and drink': 'dining',
  travel: 'travel',
  transportation: 'transportation',
  automotive: 'transportation',
  gas: 'transportation',
  shopping: 'shopping',
  health: 'health',
  'health & wellness': 'health',
  education: 'education',
  charity: 'charity',
  'gifts & donations': 'charity',
  home: 'housing',
  rent: 'housing',
  mortgage: 'loan_payment',
  fees: 'fees',
  'fees & adjustments': 'fees',
  income: 'income',
  payment: 'credit_card_payment',
  transfer: 'transfer',
  taxes: 'taxes',
  'personal care': 'personal_care',
  'bills & utilities': 'utilities',
};

/**
 * Map a bank's own category label onto the canonical set.
 *
 * Returns null for labels that carry no information ("Other", "Misc") so the
 * caller can fall back to description inference instead of burying the row in
 * `other` on the bank's say-so.
 */
export function mapProviderCategory(raw: string | null | undefined): Category | null {
  if (!raw) return null;
  const key = raw.trim().toLowerCase();
  if (key === '' || key === 'other' || key === 'misc' || key === 'miscellaneous') return null;
  return PROVIDER_CATEGORY_MAP[key] ?? null;
}

/**
 * Best category for a row, preferring precision over coverage.
 *
 * Description inference goes first because a merchant match is specific
 * ("INSTACART" → groceries) where a bank label is coarse (one issuer files
 * Instacart under "Merchandise"). The bank's label then catches the long tail
 * that no reasonable pattern list would cover.
 */
export function resolveCategory(
  description: string,
  amountCents: number,
  accountType?: string,
  providerCategory?: string | null,
): { category: Category; source: 'provider' | 'inferred' } {
  const matched = patternCategory(description, amountCents, accountType);
  if (matched) return { category: matched, source: 'inferred' };

  // The bank's label before the by-direction guess. A credit the bank files
  // under "Merchandise" is a refund, and the guess would have called it pay.
  const mapped = mapProviderCategory(providerCategory);
  if (mapped) {
    // Same liability-side reasoning as inferCategory: incoming money on an
    // asset account is a refund, not a payment.
    const isPayment = mapped === 'credit_card_payment' || mapped === 'loan_payment';
    const isLiability = accountType === 'credit' || accountType === 'loan';
    if (isPayment && amountCents > 0 && !isLiability) return { category: 'income', source: 'provider' };
    return { category: mapped, source: 'provider' };
  }

  return { category: fallbackCategory(amountCents, accountType), source: 'inferred' };
}

/** Collapse whitespace/case so the same merchant string hashes consistently. */
export function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim().toLowerCase();
}

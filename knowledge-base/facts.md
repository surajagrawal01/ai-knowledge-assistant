# ElectroNest: Company Facts (source of truth)

Every number below is the single source of truth. The database (`products` table), the Mini 1 prompts and `checkOrderPolicy`, and every document in this folder must agree with it. Change a fact here first, then update the documents and rerun the evals.

```
RETURNS
- Phones, audio, wearables, accessories: 7-day return window from delivery
- Laptops: 10-day return window from delivery
- Item must be unused and in the original box
- Exception: damaged on arrival (see below)

DAMAGED ON ARRIVAL
- Must be reported within 48 hours of delivery, with photos
- Customer can choose a replacement or a full refund
- Priority: high

REFUNDS
- Processed within 5–7 business days after the return is picked up
- UPI / card / net banking → back to the original method
- EMI → EMI cancelled; any interest is handled by the customer's bank
- COD → bank transfer only (customer shares account details)
- An order that is already refunded can never be refunded again

FAILED PAYMENTS ("money deducted but order failed")
- If a UPI/card payment fails but money was debited, the bank auto-reverses it in 5–7 business days
- Support raises a payment ticket with high priority if the customer reports a debit

WARRANTY
- Laptops, phones, wearables: 12 months from delivery
- Audio, accessories: 6 months from delivery
- Covers manufacturing defects (battery, display, motherboard, charging port)
- Does NOT cover physical damage, liquid damage, or unauthorised repair
- Safety issues (swelling battery, smoke, overheating) → escalate to a human immediately

SHIPPING
| Zone | Regions                                  | Delivery days | Charge (orders up to ₹999) |
| A    | Metro cities (Mumbai, Delhi, Bengaluru…) | 2–3           | ₹49                        |
| B    | Tier-2 cities (Jaipur, Lucknow, Kochi…)  | 4–5           | ₹79                        |
| C    | Remote areas (Gangtok, Leh, Port Blair…) | 6–8           | ₹99                        |
- Delivery days are counted from the date the order is shipped        ← added in Mini 2 (matches Mini 1's shippedDaysAgo)
- Free shipping on orders above ₹999
- A delivery counts as delayed after max days + 2 grace days (A: 5, B: 7, C: 10)
- Delayed deliveries can get a delay ticket (priority medium; high for premium customers)

CANCELLATION
- Free before shipping; payment is refunded automatically
- After shipping → the customer must use the return process

PREMIUM CUSTOMERS
- Same policies, but their tickets get one priority level higher (low → medium, medium → high)
```

## Where each fact lives in the documents

| Fact | Owning section |
|---|---|
| 7-day return window (phones, audio, wearables, accessories) | Return Policy §2.1 |
| 10-day return window (laptops) | Return Policy §2.2 |
| Unused, original box | Return Policy §2.3 |
| Damaged on arrival: 48 hours, photos | Return Policy §3.1 |
| Damaged on arrival: replacement or full refund, priority high | Return Policy §3.2 |
| Refund in 5–7 business days after pickup | Refund Policy §2 |
| UPI / card / net banking → original method | Refund Policy §3.1 |
| EMI cancelled, interest handled by the bank | Refund Policy §3.2 |
| COD → bank transfer only | Refund Policy §3.3 |
| Never refunded twice | Refund Policy §4 |
| Cancellation before / after shipping | Refund Policy §5 |
| Failed payment auto-reversal, payment ticket high | Refund Policy §6 |
| Warranty periods and covered defects | Warranty Policy §3.1 (p.2) |
| Safety issues → escalate | Warranty Policy §4.1 (p.3) |
| Exclusions | Warranty Policy §4.2 (p.3) |
| Zones, delivery days, charges, counted from ship date | Shipping Policy §2.1 |
| Free shipping above ₹999 | Shipping Policy §2.2 |
| Delay thresholds A: 5, B: 7, C: 10 | Shipping Policy §3.1 |
| Delay ticket priority | Shipping Policy §3.2 |
| Premium priority bump | FAQ, "Do premium customers get different policies?" |
